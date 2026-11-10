#!/usr/bin/env python3
"""Relevance evaluation for Library search.

Runs the golden queries through the real search service (web/scripts/search-cli.mjs) and
reports first place, recall@5, MRR and moment@5 per query language, per stored-content language, per query kind,
and same-language against cross-language.

  python3 catalog/eval/run.py                         # live snapshot, exact and hybrid
  python3 catalog/eval/run.py --snapshot ID --save    # a packed snapshot, saved to results/
  python3 catalog/eval/run.py --query-model voyage-4-large
  python3 catalog/eval/run.py --options '{"understand": false}'   # A/B one search option
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CLI = ROOT / "web" / "scripts" / "search-cli.mjs"
RESULTS = HERE / "results"
BASELINE = HERE / "baseline.json"
MOMENT_SLACK = 2
LATENCY_BUDGET_MS = {"exact": 150, "cached": 150, "hybrid_new": 1500, "understood_new": 2200}


def load_queries(path: Path = HERE / "queries.json") -> list[dict]:
    return json.loads(path.read_text())["queries"]


def run_search(queries: list[dict], mode: str, snapshot: str | None, query_model: str | None, weights: dict | None, options: dict | None = None):
    payload = {
        "mode": mode,
        "options": options or {},
        "snapshotId": snapshot,
        "queryModel": query_model,
        "weights": weights,
        "queries": [{"id": q["id"], "q": q["q"]} for q in queries],
    }
    proc = subprocess.run(
        ["node", str(CLI)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=ROOT / "web",
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(f"search-cli failed: {proc.stderr.strip()[:2000]}")
    return {row["id"]: row for row in json.loads(proc.stdout)}


def score_one(query: dict, row: dict) -> dict:
    expected = {e["video"]: e for e in query["expect"]}
    rank = None
    moment = False
    for i, result in enumerate(row["results"], start=1):
        if result["videoId"] in expected:
            if rank is None:
                rank = i
                e = expected[result["videoId"]]
                moment = any(e["from"] - MOMENT_SLACK <= t <= e["to"] + MOMENT_SLACK for t in result["moments"])
            break
    return {
        "top1": rank == 1,
        "hit5": rank is not None and rank <= 5,
        "rr": (1.0 / rank) if rank else 0.0,
        "moment5": bool(rank and rank <= 5 and moment),
        "rank": rank,
    }


def summarize(queries: list[dict], rows: dict) -> dict:
    buckets: dict[str, list[dict]] = defaultdict(list)
    per_query = {}
    for q in queries:
        s = score_one(q, rows[q["id"]])
        per_query[q["id"]] = s
        cross = q["lang"] != q["content"]
        for key in (
            "all",
            f"query:{q['lang']}",
            f"content:{q['content']}",
            f"kind:{q['kind']}",
            "cross" if cross else "same",
        ):
            buckets[key].append(s)
    table = {}
    for key, items in buckets.items():
        n = len(items)
        table[key] = {
            "n": n,
            "top1": round(sum(i["top1"] for i in items) / n, 3),
            "recall@5": round(sum(i["hit5"] for i in items) / n, 3),
            "mrr": round(sum(i["rr"] for i in items) / n, 3),
            "moment@5": round(sum(i["moment5"] for i in items) / n, 3),
        }
    return {"table": table, "per_query": per_query}


def order_keys(keys):
    head = ["all", "same", "cross"]
    rest = sorted(k for k in keys if k not in head)
    return [k for k in head if k in keys] + rest


def print_report(name: str, summary: dict) -> None:
    print(f"\n== {name}")
    print(f"{'bucket':<16}{'n':>4}{'top1':>8}{'recall@5':>10}{'mrr':>8}{'moment@5':>10}")
    for key in order_keys(summary["table"].keys()):
        row = summary["table"][key]
        print(f"{key:<16}{row['n']:>4}{row['top1']:>8.3f}{row['recall@5']:>10.3f}{row['mrr']:>8.3f}{row['moment@5']:>10.3f}")


class EvalIncomplete(RuntimeError):
    """Hybrid numbers would be exact-only numbers in disguise."""


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(p * len(ordered)))] if ordered else 0.0


def evaluate(snapshot: str | None = None, query_model: str | None = None, weights: dict | None = None, modes=("exact", "auto"), options: dict | None = None):
    queries = load_queries()
    out = {}
    for mode in modes:
        rows = run_search(queries, mode, snapshot, query_model, weights, options)
        fell_back = sorted(qid for qid, row in rows.items() if row.get("fellBack"))
        if fell_back:
            raise EvalIncomplete(
                f"{len(fell_back)} of {len(rows)} queries fell back to exact matches because query embedding "
                f"failed (for example {', '.join(fell_back[:3])}). Hybrid recall was not measured."
            )
        summary = summarize(queries, rows)
        summary["modes_seen"] = sorted({r["mode"] for r in rows.values()})
        times = [r["ms"] or 0 for r in rows.values()]
        summary["median_ms"] = percentile(times, 0.5)
        summary["p90_ms"] = percentile(times, 0.9)
        out[mode] = summary
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot")
    parser.add_argument("--query-model")
    parser.add_argument("--weights", help="JSON object of field weights")
    parser.add_argument("--options", help="JSON object of extra search options, for A/B runs")
    parser.add_argument("--save", action="store_true")
    parser.add_argument("--failures", action="store_true", help="List queries that missed the top 5")
    parser.add_argument(
        "--set-baseline",
        action="store_true",
        help="Write the hybrid recall@5 per query language to baseline.json; --promote must meet it",
    )
    args = parser.parse_args()
    weights = json.loads(args.weights) if args.weights else None
    options = json.loads(args.options) if args.options else None
    try:
        result = evaluate(args.snapshot, args.query_model, weights, options=options)
    except EvalIncomplete as err:
        print(f"Evaluation incomplete: {err}", file=sys.stderr)
        return 1
    for mode, summary in result.items():
        label = "exact only" if mode == "exact" else f"hybrid ({', '.join(summary['modes_seen'])})"
        print_report(f"{label}  median {summary['median_ms']:.0f} ms  p90 {summary['p90_ms']:.0f} ms", summary)
        if args.failures:
            misses = [qid for qid, s in summary["per_query"].items() if not s["hit5"]]
            print("missed:", ", ".join(misses) or "none")
            seconds = [f"{qid} ({s['rank']})" for qid, s in summary["per_query"].items() if s["hit5"] and not s["top1"]]
            print("not first:", ", ".join(seconds) or "none")
    if args.save:
        RESULTS.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        record = {
            "at": stamp,
            "snapshot": args.snapshot or "live",
            "query_model": args.query_model,
            "weights": weights or {},
            "options": options or {},
            "latency_ms": {mode: {"median": s["median_ms"], "p90": s["p90_ms"]} for mode, s in result.items()},
            "results": {mode: s["table"] for mode, s in result.items()},
        }
        path = RESULTS / f"{stamp}.json"
        path.write_text(json.dumps(record, indent=2) + "\n")
        print(f"\nsaved {path.relative_to(ROOT)}")
    if args.set_baseline:
        table = result["auto"]["table"]
        baseline = {
            "about": (
                "Minimum recall@5 per query language and minimum first-place rate overall for "
                "pack_snapshot.py --promote. Set by run.py --set-baseline. latency_budget_ms is the "
                "per-request target measured over HTTP (scripts/search-debug.mjs prints timings)."
            ),
            "snapshot": args.snapshot or "live",
            "query_model": args.query_model,
            "recall@5": {k: v["recall@5"] for k, v in table.items() if k == "all" or k.startswith("query:")},
            "top1": {k: v["top1"] for k, v in table.items() if k == "all" or k.startswith("kind:")},
            "latency_budget_ms": LATENCY_BUDGET_MS,
        }
        BASELINE.write_text(json.dumps(baseline, indent=2) + "\n")
        print(f"baseline written to {BASELINE.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
