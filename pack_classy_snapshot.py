#!/usr/bin/env python3
"""Pack a Classy snapshot from lab tables, or index the reels already in the app.

The cut sentence is attached only when the timing overlap is the 78-clip set.
Instagram reel ids already in the web pack never receive that sentence.
Query-time embeddings are not written into the browser. The vector file records
the model name and dimension so a later query model can be refused on mismatch.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

STOP = {
    "a",
    "an",
    "and",
    "at",
    "for",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
}
N_VERTICES = 20484
VERCEL_BUDGET = 100 * 1024 * 1024
MIN_TIMING_SECONDS = 8
EXPECTED_TIMING = 78


def tokenize(text: str) -> list[str]:
    cleaned = str(text or "").lower().replace("'", "").replace("’", "")
    return [
        token
        for token in re.split(r"[^a-z0-9]+", cleaned)
        if len(token) > 1 and token not in STOP
    ]


def as_float(value):
    text = str(value).strip()
    if text == "" or text.lower() == "nan":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def tag_list(value):
    try:
        tags = json.loads(value) if str(value).startswith("[") else []
    except json.JSONDecodeError:
        tags = []
    return tags if isinstance(tags, list) else []


def json_load(value, fallback):
    text = str(value or "").strip()
    if not text:
        return fallback
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return fallback


def overlaps(start, end, second) -> bool:
    return start < second + 1 and end > second


def cut_seconds(shots: list[dict]) -> set[int]:
    starts = []
    for shot in shots:
        start = as_float(shot.get("start_sec"))
        if start is not None:
            starts.append(start)
    starts.sort()
    return {int(math.floor(start)) for start in starts[1:]}


def resolve_lab_root() -> Path | None:
    candidates = []
    override = os.environ.get("VIRALITY_ROOT", "").strip()
    if override:
        candidates.append(Path(override))
    candidates.append(Path("/content/drive/MyDrive/virality_poc"))
    home = Path.home()
    cloud = home / "Library" / "CloudStorage"
    if cloud.exists():
        for drive in cloud.iterdir():
            candidates.append(drive / "My Drive" / "virality_poc")
    candidates.append(home / "Desktop" / "virality_poc")
    for root in candidates:
        timeline = root / "features" / "full" / "timeline.csv"
        events = root / "features" / "full" / "events.csv"
        if timeline.exists() and events.exists():
            return root
    return None


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def docs_from_knowledge(knowledge: dict) -> list[dict]:
    docs = []
    for video in knowledge.get("videos") or []:
        vid = video.get("id")
        if not vid:
            continue
        for event in video.get("content_events") or []:
            text = str(event.get("content") or "").strip()
            if not text:
                continue
            kind = event.get("type")
            field = {
                "speech": "speech",
                "text_overlay": "text_on_screen",
                "scene_change": "scene",
            }.get(kind)
            if not field:
                continue
            docs.append(
                {
                    "videoId": vid,
                    "tSec": float(event.get("t_sec") or 0),
                    "field": field,
                    "text": text,
                }
            )
        names = (video.get("networks") or {}).get("top") or []
        if names:
            docs.append(
                {
                    "videoId": vid,
                    "tSec": 0,
                    "field": "activation",
                    "text": " ".join(str(name) for name in names),
                }
            )
    return docs


def write_search(out: Path, docs: list[dict], snapshot_id: str) -> None:
    search = out / "search"
    search.mkdir(parents=True, exist_ok=True)
    (search / "index.json").write_text(
        json.dumps({"snapshotId": snapshot_id, "docs": docs}, indent=2)
    )
    (search / "vectors.json").write_text(
        json.dumps(
            {
                "snapshotId": snapshot_id,
                "model": None,
                "dimensions": 0,
                "queryModel": None,
                "vectors": [],
                "reason": (
                    "Sentence vectors are reserved for a pack-time multilingual model. "
                    "A query model is not loaded in the browser or the Vercel function. "
                    "Search uses the exact-word index and token overlap over stored records."
                ),
            },
            indent=2,
        )
    )


def folder_bytes(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for item in path.rglob("*"):
        if item.is_file():
            total += item.stat().st_size
    return total


def write_pointer(out: Path, payload: dict) -> None:
    (out / "current.json").write_text(json.dumps(payload, indent=2))


def knowledge_snapshot(web_data: Path) -> dict:
    knowledge_path = web_data / "knowledge.json"
    knowledge = json.loads(knowledge_path.read_text())
    snapshot_id = "ig-extracted"
    docs = docs_from_knowledge(knowledge)
    write_search(web_data, docs, snapshot_id)
    measured = folder_bytes(web_data)
    pointer = {
        "id": snapshot_id,
        "host": "public-data",
        "fitsExistingDeploy": measured <= VERCEL_BUDGET,
        "bytes": measured,
        "bucket": None,
        "timingEligible": [],
        "search": "search/index.json",
        "vectors": "search/vectors.json",
        "vectorModel": None,
        "vectorDimensions": 0,
        "instagramCutSentence": False,
    }
    write_pointer(web_data, pointer)
    print(
        f"Indexed {len(docs)} extracted records from the current reels. "
        f"Pack is {measured} bytes. Cut sentences were not attached.",
        flush=True,
    )
    return pointer


def find_mp4(root: Path, video_id: str, row: dict) -> Path | None:
    listed = str(row.get("mp4_path") or "").strip()
    candidates = []
    if listed:
        candidates.append(Path(listed))
        candidates.append(root / listed)
    candidates.extend(
        [
            root / "media" / "mp4" / f"{video_id}.mp4",
            root / "videos" / f"{video_id}.mp4",
        ]
    )
    for path in candidates:
        if path.exists() and path.stat().st_size > 0:
            return path
    return None


def activation_path(root: Path, video_id: str) -> Path | None:
    path = root / "outputs" / "text_full" / video_id / "activation.npy"
    if path.exists() and path.stat().st_size > 0:
        return path
    return None


def curve_seconds(root: Path) -> dict[str, set[int]]:
    parquet = root / "features" / "tribe_timeline.parquet"
    if not parquet.exists():
        return {}
    import pandas as pd

    frame = pd.read_parquet(parquet, columns=["video_id", "t_sec"])
    grouped: dict[str, set[int]] = {}
    for video_id, second in zip(frame["video_id"], frame["t_sec"]):
        grouped.setdefault(str(video_id), set()).add(int(float(second)))
    return grouped


def build_seconds(timeline_rows, event_rows, curve_means) -> list[dict]:
    shots = []
    scenes = []
    outcomes = []
    asks = []
    for event in event_rows:
        tags = [str(tag) for tag in tag_list(event.get("tags"))]
        start = as_float(event.get("start_sec"))
        end = as_float(event.get("end_sec"))
        if start is None or end is None:
            continue
        head = tags[0] if tags else ""
        if head == "shot":
            shots.append(event)
        elif head == "scene":
            scenes.append((start, end, event))
        elif head == "outcome":
            outcomes.append((start, end, event))
        elif head == "ask" and event.get("source") == "both":
            asks.append((start, end, event, tags[1] if len(tags) > 1 else ""))
    cuts = cut_seconds(shots)
    seconds = []
    for row in sorted(timeline_rows, key=lambda item: int(float(item["t_sec"]))):
        second = int(float(row["t_sec"]))
        text = json_load(row.get("text_on_screen"), [])
        labels = json_load(row.get("labels"), [])
        sentiment = json_load(row.get("sentiment"), None)
        scene_rows = [
            {
                "source": event.get("source") or "",
                "sentence": event.get("text") or "",
                "evidence": event.get("evidence") or "",
            }
            for start, end, event in scenes
            if overlaps(start, end, second) and (event.get("text") or "")
        ]
        outcome_rows = [
            {
                "source": event.get("source") or "",
                "sentence": event.get("text") or "",
                "evidence": event.get("evidence") or "",
            }
            for start, end, event in outcomes
            if overlaps(start, end, second) and (event.get("text") or "")
        ]
        ask = None
        for start, end, event, kind in asks:
            if overlaps(start, end, second):
                ask = {
                    "kind": kind,
                    "phrase_en": event.get("text") or "",
                    "phrase_original": event.get("evidence") or "",
                }
                break
        app = None
        if (as_float(row.get("app_on")) or 0) > 0:
            app = {"evidence": "Agreed app screen"}
        means = curve_means.get(second, {})
        seconds.append(
            {
                "t_sec": second,
                "speech": row.get("speech") or "",
                "speech_score": row.get("speech_score") or None,
                "speaker": row.get("speaker") or "",
                "text_on_screen": text if isinstance(text, list) else [],
                "labels": labels if isinstance(labels, list) else [],
                "face_count": int(float(row["face_count"])) if str(row.get("face_count") or "").strip() else 0,
                "music_score": row.get("music_score") or None,
                "sentiment": sentiment,
                "scenes": scene_rows,
                "outcomes": outcome_rows,
                "app": app,
                "ask": ask,
                "visual_mean_abs": means.get("visual"),
                "dorsal_mean_abs": means.get("dorsal"),
                "cut": second in cuts,
            }
        )
    return seconds, sorted(cuts)


def network_means(activation, labels) -> dict[int, dict]:
    import numpy as np

    act = activation
    if act.shape[0] != labels.size and act.shape[1] == labels.size:
        act = act.T
    if act.shape[0] != labels.size:
        raise RuntimeError(f"activation {act.shape} does not match atlas {labels.size}")
    absolute = np.abs(act)
    visual = labels == 1
    dorsal = labels == 3
    means = {}
    for second in range(absolute.shape[1]):
        means[second] = {
            "visual": round(float(absolute[visual, second].mean()), 6),
            "dorsal": round(float(absolute[dorsal, second].mean()), 6),
        }
    return means


def docs_from_seconds(video_id: str, seconds: list[dict], topics: str, keywords: str) -> list[dict]:
    docs = []
    for row in seconds:
        pairs = [
            ("speech", row.get("speech") or ""),
            (
                "text_on_screen",
                " ".join(
                    item.get("text", "")
                    for item in row.get("text_on_screen") or []
                    if isinstance(item, dict)
                ),
            ),
        ]
        for scene in row.get("scenes") or []:
            pairs.append(("scene", scene.get("sentence") or ""))
            pairs.append(("evidence", scene.get("evidence") or ""))
        for outcome in row.get("outcomes") or []:
            pairs.append(("scene", outcome.get("sentence") or ""))
            pairs.append(("evidence", outcome.get("evidence") or ""))
        ask = row.get("ask") or {}
        if ask:
            pairs.append(("ask", " ".join(part for part in (ask.get("phrase_original"), ask.get("phrase_en")) if part)))
        for field, text in pairs:
            cleaned = str(text).strip()
            if cleaned:
                docs.append(
                    {
                        "videoId": video_id,
                        "tSec": row["t_sec"],
                        "field": field,
                        "text": cleaned,
                    }
                )
    for field, raw in (("topic", topics), ("keyword", keywords)):
        parsed = json_load(raw, [])
        names = []
        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict):
                    names.append(str(item.get("name") or item.get("text") or ""))
                else:
                    names.append(str(item))
        text = " ".join(name for name in names if name.strip())
        if text:
            docs.append({"videoId": video_id, "tSec": 0, "field": field, "text": text})
    return docs


def pack_lab(root: Path, web_data: Path) -> None:
    dataset_path = root / "datasets" / "dataset_v1.csv"
    if not dataset_path.exists():
        raise SystemExit(f"missing {dataset_path}. Pointer not moved.")
    dataset = read_csv(dataset_path)
    timeline = read_csv(root / "features" / "full" / "timeline.csv")
    events = read_csv(root / "features" / "full" / "events.csv")
    video_table = {}
    video_csv = root / "features" / "full" / "video.csv"
    if video_csv.exists():
        video_table = {row["video_id"]: row for row in read_csv(video_csv)}
    by_time: dict[str, list] = {}
    for row in timeline:
        by_time.setdefault(row["video_id"], []).append(row)
    by_event: dict[str, list] = {}
    for row in events:
        by_event.setdefault(row["video_id"], []).append(row)
    curves = curve_seconds(root)

    library_ids = [row["video_id"] for row in dataset if row.get("video_id")]
    searchable = []
    blocked = []
    for video_id in library_ids:
        has_time = video_id in by_time
        has_curve = activation_path(root, video_id) is not None or video_id in curves
        if has_time and has_curve:
            searchable.append(video_id)
        elif has_time or has_curve:
            blocked.append(video_id)
    if blocked:
        raise SystemExit(
            "Pointer not moved. A searchable clip is missing a timeline or a curve: "
            + ", ".join(blocked)
        )

    mp4_bytes = 0
    act_bytes = 0
    for video_id in searchable:
        row = next(item for item in dataset if item["video_id"] == video_id)
        mp4 = find_mp4(root, video_id, row)
        npy = activation_path(root, video_id)
        if mp4:
            mp4_bytes += mp4.stat().st_size
        if npy:
            act_bytes += npy.stat().st_size
    estimated = mp4_bytes + act_bytes // 4
    existing = folder_bytes(web_data)
    fits = existing + estimated <= VERCEL_BUDGET
    print(
        f"Measured mp4 {mp4_bytes} bytes and activation {act_bytes} bytes. "
        f"Estimated pack addition {estimated}. Existing public data {existing}. "
        f"Fits the current deploy budget: {fits}.",
        flush=True,
    )

    from web_export import load_yeo7_labels, quantize_activation
    import numpy as np

    labels = load_yeo7_labels(Path(__file__).resolve().parent / "reference" / "yeo2011", N_VERTICES // 2)
    eligible = []
    packed_docs = []
    manifest_path = web_data / "manifest.json"
    knowledge_path = web_data / "knowledge.json"
    manifest = json.loads(manifest_path.read_text())
    knowledge = json.loads(knowledge_path.read_text())
    existing_ids = {video["id"] for video in manifest.get("videos") or []}
    act_dir = web_data / "act"
    video_dir = web_data / "videos"
    seconds_dir = web_data / "seconds"
    act_dir.mkdir(parents=True, exist_ok=True)
    video_dir.mkdir(parents=True, exist_ok=True)
    seconds_dir.mkdir(parents=True, exist_ok=True)

    for video_id in searchable:
        if video_id in existing_ids and not video_id.startswith("v"):
            continue
        row = next(item for item in dataset if item["video_id"] == video_id)
        npy = activation_path(root, video_id)
        if npy is None:
            raise SystemExit(f"Pointer not moved. {video_id} has no activation.")
        act = np.load(npy)
        means = network_means(act, labels)
        seconds, cuts = build_seconds(by_time[video_id], by_event.get(video_id, []), means)
        overlap = set(int(item["t_sec"]) for item in seconds) & curves.get(video_id, set(int(item["t_sec"]) for item in seconds))
        timing = len(overlap) >= MIN_TIMING_SECONDS
        if timing:
            eligible.append(video_id)
        meta = video_table.get(video_id, {})
        payload = {
            "videoId": video_id,
            "timingEligible": False,
            "cuts": cuts,
            "language": meta.get("language") or "",
            "topics": meta.get("topics") or "",
            "keywords": meta.get("keywords") or "",
            "seconds": seconds,
        }
        (seconds_dir / f"{video_id}.json").write_text(json.dumps(payload))
        u8, frames = quantize_activation(act, 90)
        (act_dir / f"{video_id}.bin").write_bytes(u8.tobytes())
        mp4 = find_mp4(root, video_id, row)
        if mp4:
            shutil.copyfile(mp4, video_dir / f"{video_id}.mp4")
        entry = {
            "id": video_id,
            "account": row.get("creator") or "",
            "tier": "library",
            "group": "library",
            "video": f"videos/{video_id}.mp4",
            "duration": as_float(row.get("duration_s")) or as_float(meta.get("duration_sec")) or len(seconds),
            "frames": frames,
            "timingEligible": False,
            "cuts": cuts,
            "metrics": {
                "plays": as_float(row.get("views") or row.get("plays")),
                "likes": as_float(row.get("likes")),
                "comments": as_float(row.get("comments")),
                "followers": as_float(row.get("followers")),
                "shares": as_float(row.get("shares")),
                "saves": as_float(row.get("saves")),
            },
            "annotations": {},
            "features": {},
            "url": row.get("url") or "",
            "posted_at": row.get("posted_at") or "",
        }
        manifest["videos"] = [item for item in manifest["videos"] if item["id"] != video_id]
        manifest["videos"].append(entry)
        knowledge_entry = {
            **entry,
            "content_events": [],
            "story": [
                {
                    "t_sec": second["t_sec"],
                    "events": [],
                }
                for second in seconds
            ],
            "networks": {},
        }
        knowledge["videos"] = [item for item in knowledge["videos"] if item["id"] != video_id]
        knowledge["videos"].append(knowledge_entry)
        packed_docs.extend(
            docs_from_seconds(
                video_id,
                seconds,
                meta.get("topics") or "",
                meta.get("keywords") or "",
            )
        )
        print(f"packed {video_id} seconds={len(seconds)} cuts={len(cuts)}", flush=True)

    attach = len(eligible) == EXPECTED_TIMING
    if not attach:
        print(
            f"Timing overlap is {len(eligible)}, not {EXPECTED_TIMING}. "
            "Cut sentences stay off.",
            flush=True,
        )
    else:
        eligible_set = set(eligible)
        for collection in (manifest["videos"], knowledge["videos"]):
            for video in collection:
                if video["id"] in eligible_set:
                    video["timingEligible"] = True
        for video_id in eligible_set:
            path = seconds_dir / f"{video_id}.json"
            payload = json.loads(path.read_text())
            payload["timingEligible"] = True
            path.write_text(json.dumps(payload))
        print(f"Cut sentences attached to {EXPECTED_TIMING} clips.", flush=True)

    for video in manifest["videos"]:
        if video["id"] in existing_ids and not str(video["id"]).startswith("v"):
            video["timingEligible"] = False
            video.pop("cuts", None)
    for video in knowledge["videos"]:
        if video["id"] in existing_ids and not str(video["id"]).startswith("v"):
            video["timingEligible"] = False
            video.pop("cuts", None)

    manifest["n"] = len(manifest["videos"])
    manifest_path.write_text(json.dumps(manifest, indent=2))
    knowledge_path.write_text(json.dumps(knowledge, indent=2))
    instagram = [
        video
        for video in json.loads(knowledge_path.read_text())["videos"]
        if video["id"] in existing_ids and not str(video["id"]).startswith("v")
    ]
    docs = docs_from_knowledge({"videos": instagram}) + packed_docs
    snapshot_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    write_search(web_data, docs, snapshot_id)
    measured = folder_bytes(web_data)
    write_pointer(
        web_data,
        {
            "id": snapshot_id,
            "host": "public-data" if fits and measured <= VERCEL_BUDGET else "public-data-over-budget",
            "fitsExistingDeploy": bool(fits and measured <= VERCEL_BUDGET),
            "bytes": measured,
            "bucket": None,
            "timingEligible": eligible if attach else [],
            "search": "search/index.json",
            "vectors": "search/vectors.json",
            "vectorModel": None,
            "vectorDimensions": 0,
            "instagramCutSentence": False,
        },
    )
    print(f"Pointer moved to {snapshot_id}.", flush=True)


def self_check() -> None:
    shots = [{"start_sec": "0.2"}, {"start_sec": "2.4"}, {"start_sec": "5"}]
    cuts = cut_seconds(shots)
    if cuts != {2, 5}:
        raise SystemExit(f"cut rule failed: {cuts}")
    tokens = tokenize("The mitosis notes, and the app")
    if tokens != ["mitosis", "notes", "app"]:
        raise SystemExit(f"tokenizer failed: {tokens}")
    print("self-check ok", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Pack the Classy snapshot")
    parser.add_argument("--data", type=Path, default=Path(__file__).resolve().parent / "web" / "public" / "data")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    self_check()
    if args.self_check:
        return
    root = resolve_lab_root()
    if root is None:
        print(
            "Lab timeline and events are not on this machine. "
            "Indexing the extracted records already in the app. "
            "Cut sentences stay off the Instagram reels.",
            flush=True,
        )
        knowledge_snapshot(args.data)
        return
    pack_lab(root, args.data)


if __name__ == "__main__":
    main()
