"""Validate, promote and roll back snapshots.

Packing never moves the pointer. A snapshot goes live only through promote(), which
re-validates it and then moves the pointer with compare-and-swap, recording a history row.
Snapshots and their objects are immutable, so rollback rewrites nothing.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

BLOCKED = {"v019", "v035", "v036", "v054", "v080", "v084", "v090"}
VIDEO_ID = re.compile(r"^v\d+$")
EXPECTED_TIMING = 78
NORM_TOLERANCE = 1e-3
KEEP_SNAPSHOTS = 3
BASELINE_PATH = Path(__file__).resolve().parent / "eval" / "baseline.json"


class GateError(RuntimeError):
    pass


@dataclass
class Report:
    snapshot_id: str
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures

    def check(self, condition: bool, failure: str) -> None:
        if not condition:
            self.failures.append(failure)

    def render(self) -> str:
        lines = [f"validate {self.snapshot_id}: {'pass' if self.ok else 'FAIL'}"]
        lines += [f"  fail: {line}" for line in self.failures]
        lines += [f"  note: {line}" for line in self.notes]
        return "\n".join(lines)


def current_pointer(cur) -> str | None:
    cur.execute("SELECT snapshot_id FROM pointer WHERE id = 1")
    row = cur.fetchone()
    return row[0] if row else None


def object_exists(key: str, root: Path) -> bool:
    bucket = os.environ.get("CLASSY_BUCKET", "").strip()
    if bucket:
        from google.cloud import storage

        blob = storage.Client().bucket(bucket).get_blob(key)
        return bool(blob and blob.size)
    path = root / key
    return path.is_file() and path.stat().st_size > 0


def sprite_ok(meta) -> bool:
    """A frame sprite grid the web can index: count frames in cols x rows cells, positive spacing."""
    if not isinstance(meta, dict):
        return False
    try:
        cols, rows, count, interval = int(meta["cols"]), int(meta["rows"]), int(meta["count"]), float(meta["interval"])
    except (KeyError, TypeError, ValueError):
        return False
    return cols > 0 and rows > 0 and 0 < count <= cols * rows and interval > 0


def golden_check(report: Report, snapshot_id: str, live_id: str | None, evaluate, baseline_path: Path) -> None:
    """Candidate recall@5 per query language must meet the saved baseline and the live snapshot."""
    try:
        candidate = evaluate(snapshot_id)
        live = evaluate(live_id) if live_id and live_id != snapshot_id else None
    except RuntimeError as err:
        report.failures.append(f"golden queries could not run: {err}")
        return
    baseline, top1_floor = {}, None
    if baseline_path.exists():
        saved = json.loads(baseline_path.read_text())
        baseline = saved.get("recall@5", {})
        top1_floor = saved.get("top1", {}).get("all")
    top1 = candidate.get("all", {}).get("top1")
    if top1_floor is not None and top1 is not None and top1 < top1_floor:
        report.failures.append(f"golden all first place {top1:.3f} below baseline {top1_floor:.3f}")
    for bucket, row in sorted(candidate.items()):
        if not (bucket == "all" or bucket.startswith("query:")):
            continue
        floor = baseline.get(bucket)
        if floor is not None and row["recall@5"] < floor:
            report.failures.append(f"golden {bucket} recall@5 {row['recall@5']:.3f} below baseline {floor:.3f}")
        if live and bucket in live and row["recall@5"] < live[bucket]["recall@5"]:
            report.failures.append(
                f"golden {bucket} recall@5 {row['recall@5']:.3f} below live {live[bucket]['recall@5']:.3f}"
            )
    report.notes.append(f"golden all recall@5 {candidate.get('all', {}).get('recall@5')}")


def validate(
    conn,
    snapshot_id: str,
    *,
    profile: str | None,
    object_root: Path,
    allow_exact_only: bool = False,
    evaluate=None,
    baseline_path: Path = BASELINE_PATH,
) -> Report:
    """Every check runs against `snapshot_id` only. `evaluate(snapshot_id)` returns recall tables."""
    report = Report(snapshot_id)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT complete, embedding_profile, embedding_dim FROM snapshot WHERE id = %s",
            (snapshot_id,),
        )
        row = cur.fetchone()
        if not row:
            report.failures.append("snapshot does not exist")
            return report
        complete, snap_profile, dim = row
        report.check(bool(complete), "snapshot is not complete")

        cur.execute(
            "SELECT count(*), count(embedding) FROM chunk WHERE snapshot_id = %s",
            (snapshot_id,),
        )
        total, embedded = cur.fetchone()
        report.check(total > 0, "snapshot has no chunks")
        if allow_exact_only:
            report.notes.append(f"exact-only allowed; {embedded}/{total} chunks have vectors")
        else:
            report.check(embedded == total, f"vector coverage {embedded}/{total}, not 100 percent")
            report.check(bool(snap_profile), "embedding profile is not set")
            report.check(
                not profile or snap_profile == profile,
                f"embedding profile {snap_profile} does not match the query provider {profile}",
            )
        if embedded:
            report.check(bool(dim), "embedding dimension is not set")
            cur.execute(
                """
                SELECT count(*) FROM chunk
                WHERE snapshot_id = %s AND embedding IS NOT NULL
                  AND (vector_dims(embedding) <> %s OR abs(vector_norm(embedding) - 1) > %s)
                """,
                (snapshot_id, dim or 0, NORM_TOLERANCE),
            )
            bad = cur.fetchone()[0]
            report.check(bad == 0, f"{bad} vectors have the wrong dimension or are not unit length")

        cur.execute(
            """
            SELECT c.video_id,
                   coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(c.curve) = 'array' THEN c.curve END), 0),
                   (SELECT count(*) FROM second s WHERE s.snapshot_id = c.snapshot_id AND s.video_id = c.video_id),
                   c.timing_eligible, c.mp4_object, c.act_object, c.sprite_object, c.sprite_meta
            FROM clip c WHERE c.snapshot_id = %s
            """,
            (snapshot_id,),
        )
        clips = cur.fetchall()
    report.check(bool(clips), "snapshot has no videos")
    bad_ids = sorted(video_id for video_id, *_ in clips if not VIDEO_ID.match(video_id) or video_id in BLOCKED)
    report.check(not bad_ids, f"excluded ids present: {', '.join(bad_ids)}")
    no_curve = sorted(video_id for video_id, curve_len, seconds, *_ in clips if curve_len == 0 or seconds == 0)
    report.check(not no_curve, f"videos without a timeline and a curve: {', '.join(no_curve)}")
    timing = sum(1 for clip in clips if clip[3])
    report.check(timing in (0, EXPECTED_TIMING), f"timing set is {timing}, must be 0 or exactly {EXPECTED_TIMING}")
    missing = []
    no_frames = []
    for video_id, _curve, _seconds, _timing, mp4_key, act_key, sprite_key, sprite_meta in clips:
        for key in (mp4_key, act_key, sprite_key):
            if key and not object_exists(key, object_root):
                missing.append(key)
        if mp4_key and not (sprite_key and sprite_ok(sprite_meta)):
            no_frames.append(video_id)
    report.check(not missing, f"{len(missing)} object keys missing or empty, e.g. {missing[:3]}")
    report.check(not no_frames, f"videos without a frame sprite: {', '.join(sorted(no_frames)[:10])}")
    report.notes.append(f"{len(clips)} videos, {total} chunks, timing set {timing}")

    if evaluate is not None and report.ok:
        with conn.cursor() as cur:
            live_id = current_pointer(cur)
        golden_check(report, snapshot_id, live_id, evaluate, baseline_path)
    return report


def move_pointer(conn, *, to_snapshot: str, expected: str | None, reason: str) -> None:
    """Compare-and-swap the pointer and record history in one transaction."""
    with conn.cursor() as cur:
        cur.execute("SELECT complete FROM snapshot WHERE id = %s", (to_snapshot,))
        row = cur.fetchone()
        if not row or not row[0]:
            conn.rollback()
            raise GateError(f"{to_snapshot} is not a complete snapshot")
        cur.execute(
            "UPDATE pointer SET snapshot_id = %s WHERE id = 1 AND snapshot_id IS NOT DISTINCT FROM %s",
            (to_snapshot, expected),
        )
        if cur.rowcount != 1:
            conn.rollback()
            raise GateError("the pointer moved while this ran; nothing changed")
        cur.execute(
            "INSERT INTO pointer_history (from_snapshot, to_snapshot, reason) VALUES (%s, %s, %s)",
            (expected, to_snapshot, reason),
        )
    conn.commit()


def promote(conn, snapshot_id: str, *, reason: str = "promote", **validate_kwargs) -> Report:
    with conn.cursor() as cur:
        expected = current_pointer(cur)
    conn.commit()
    if expected == snapshot_id:
        raise GateError(f"{snapshot_id} is already live")
    report = validate(conn, snapshot_id, **validate_kwargs)
    if not report.ok:
        raise GateError(report.render())
    move_pointer(conn, to_snapshot=snapshot_id, expected=expected, reason=reason)
    return report


def rollback(conn) -> tuple[str, str]:
    """Point back at the snapshot that was live before the current one."""
    with conn.cursor() as cur:
        live = current_pointer(cur)
        cur.execute(
            """
            SELECT from_snapshot FROM pointer_history
            WHERE to_snapshot = %s AND from_snapshot IS NOT NULL
            ORDER BY id DESC LIMIT 1
            """,
            (live,),
        )
        row = cur.fetchone()
    conn.commit()
    if not row:
        raise GateError(f"no earlier snapshot recorded before {live}")
    target = row[0]
    move_pointer(conn, to_snapshot=target, expected=live, reason="rollback")
    return live, target


def prune(conn, object_root: Path, keep: int = KEEP_SNAPSHOTS, *, dry_run: bool = False) -> list[str]:
    """Delete incomplete snapshots and all but the newest `keep` complete ones. Never the live one."""
    with conn.cursor() as cur:
        live = current_pointer(cur)
        cur.execute("SELECT id, complete FROM snapshot ORDER BY created_at DESC, id DESC")
        rows = cur.fetchall()
    complete = [sid for sid, done in rows if done]
    keep_ids = set(complete[:keep]) | {live}
    doomed = [sid for sid, _done in rows if sid not in keep_ids]
    if dry_run or not doomed:
        return doomed
    with conn.cursor() as cur:
        for table in ("chunk", "event", "second", "clip"):
            cur.execute(f"DELETE FROM {table} WHERE snapshot_id = ANY(%s)", (doomed,))
        cur.execute(
            "DELETE FROM pointer_history WHERE from_snapshot = ANY(%s) OR to_snapshot = ANY(%s)",
            (doomed, doomed),
        )
        cur.execute("DELETE FROM snapshot WHERE id = ANY(%s)", (doomed,))
    conn.commit()
    for sid in doomed:
        shutil.rmtree(object_root / "snapshots" / sid, ignore_errors=True)
    return doomed
