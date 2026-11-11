#!/usr/bin/env python3
"""Pack a Classy snapshot into Postgres and private objects, then gate it.

A clip is packed only when it has an Azure Video Indexer timeline and a predicted
curve. Instagram ids and blocked ids are never packed. Timing sentences attach only when
the snapshot's eligible count is exactly 78. Packing never moves the pointer unless --live:

  pack_snapshot.py                    pack a new snapshot from the lab files (not live)
  pack_snapshot.py --derive BASE --add v210 [--add v211] [--drop v031] [--live]
                                      new snapshot = BASE with videos added or dropped;
                                      kept videos are copied, only added ones cost work
  pack_snapshot.py --finish ID        embed and complete a snapshot whose pack stopped
  pack_snapshot.py --validate ID      run every check against ID
  pack_snapshot.py --promote ID       validate, then move the pointer (compare-and-swap)
  pack_snapshot.py --rollback         point back at the previously live snapshot
  pack_snapshot.py --prune            keep the newest 3 complete snapshots and the live one

Ingest states (table ingest, one row per video):

  queued -> fetching -> tribe -> indexing -> packing -> validating -> live
  any state -> failed (detail says why); blocked ids never leave blocked

fetching, tribe and indexing belong to the ingest worker (download, TRIBE, Video Indexer and
Content Understanding). This script owns packing, validating and live: build_video reads one
video from a source, write_video writes it into a snapshot, the gate validates the snapshot,
and promotion makes every video in it live.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import psycopg2
from psycopg2.extras import Json, execute_values

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "catalog"))

import frames  # noqa: E402
import gate  # noqa: E402
from providers.embedding import (  # noqa: E402
    EmbeddingError,
    embed_with_cache,
    format_document,
    get_document_provider,
)
from segments import chunks_for  # noqa: E402

from pack_classy_snapshot import (  # noqa: E402
    EXPECTED_TIMING,
    MIN_TIMING_SECONDS,
    activation_path,
    as_float,
    build_seconds,
    curve_seconds,
    find_mp4,
    json_load,
    read_csv,
    resolve_lab_root,
)
from web_export import load_yeo7_labels, network_features, neural_features, quantize_activation  # noqa: E402

BLOCKED = gate.BLOCKED
QUOTE_FLOOR = float(os.environ.get("CLASSY_QUOTE_FLOOR", "0.5"))
EVENT_SOURCES = {"video_indexer", "content_understanding", "gemini", "both"}


def include_id(video_id: str) -> bool:
    return bool(video_id) and video_id.startswith("v") and video_id not in BLOCKED


def normalize_score(value):
    number = as_float(value)
    if number is None:
        return None
    if number > 1:
        number = number / 100
    if number < 0 or number > 1:
        return None
    return round(number, 4)


def database_url() -> str:
    """Local Postgres by default. A Neon URL is allowed only for a non-production branch."""
    url = os.environ.get("DATABASE_URL", "postgresql:///classy")
    if os.environ.get("CLASSY_ALLOW_PRODUCTION") == "1":
        return url
    host = ""
    try:
        host = urlparse(url.replace("postgresql:", "http:", 1)).hostname or ""
    except ValueError:
        host = ""
    branch = os.environ.get("NEON_BRANCH", "")
    if host.endswith(".neon.tech") and branch in ("", "production"):
        raise SystemExit(
            "Refusing the production database. Use the dev branch, "
            "or set CLASSY_ALLOW_PRODUCTION=1 for this command."
        )
    return url


def object_root() -> Path:
    raw = os.environ.get("CLASSY_OBJECT_ROOT", "").strip()
    path = Path(raw) if raw else ROOT / "catalog" / "objects"
    path.mkdir(parents=True, exist_ok=True)
    return path


def apply_schema(conn) -> None:
    schema = Path(__file__).with_name("schema.sql").read_text()
    with conn.cursor() as cur:
        cur.execute(schema)
    conn.commit()


def lab_tables(root: Path):
    timeline_path = root / "features" / "full" / "timeline.csv"
    events_path = root / "features" / "full" / "events.csv"
    if not timeline_path.exists():
        return None
    timeline = [row for row in read_csv(timeline_path) if include_id(row.get("video_id", ""))]
    events = []
    if events_path.exists():
        events = [
            row
            for row in read_csv(events_path)
            if include_id(row.get("video_id", "")) and row.get("source") in EVENT_SOURCES
        ]
    video_csv = root / "features" / "full" / "video.csv"
    videos = {}
    if video_csv.exists():
        videos = {row["video_id"]: row for row in read_csv(video_csv) if include_id(row.get("video_id", ""))}
    dataset = {}
    dataset_path = root / "datasets" / "dataset_v1.csv"
    if dataset_path.exists():
        dataset = {row["video_id"]: row for row in read_csv(dataset_path) if include_id(row.get("video_id", ""))}
    return timeline, events, videos, dataset


def tribe_error(root: Path, video_id: str) -> str:
    summary = json_load_file(root / "outputs" / "text_full" / video_id / "summary.json")
    error = summary.get("error") if isinstance(summary, dict) else None
    return str(error).splitlines()[0][:300] if error else ""


def json_load_file(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def timing_set(dataset: dict, timeline_seconds: dict, curves: dict) -> list[str]:
    if not curves:
        return []
    out = []
    for video_id, row in dataset.items():
        if str(row.get("save_model") or "").strip() != "1":
            continue
        overlap = timeline_seconds.get(video_id, set()) & curves.get(video_id, set())
        if len(overlap) >= MIN_TIMING_SECONDS:
            out.append(video_id)
    return sorted(out)


def network_record(activation, labels) -> dict:
    """Same object as web_export.network_features. Label 0 is left out of the means."""
    act = np.asarray(activation)
    if act.ndim != 2:
        return {}
    if act.shape[0] != labels.size and act.shape[1] == labels.size:
        act = act.T
    if act.shape[0] != labels.size:
        return {}
    return network_features(act, None, labels)


def top_networks(activation, labels) -> str:
    act = activation
    if act.shape[0] != labels.size and act.shape[1] == labels.size:
        act = act.T
    if act.shape[0] != labels.size:
        return ""
    absolute = np.abs(act).mean(axis=1)
    scores = []
    names = {
        1: "Visual",
        2: "Somatomotor",
        3: "Dorsal Attention",
        4: "Ventral Attention",
        5: "Limbic",
        6: "Frontoparietal",
        7: "Default Mode Network",
    }
    for network_id, name in names.items():
        mask = labels == network_id
        if mask.any():
            scores.append((float(absolute[mask].mean()), name))
    scores.sort(reverse=True)
    return " ".join(name for _score, name in scores[:3])


def tag_names(raw: str) -> list[str]:
    parsed = json_load(raw, [])
    names = []
    if isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict):
                names.append(str(item.get("name") or item.get("text") or ""))
            else:
                names.append(str(item))
    return [name for name in names if name.strip()]


def faststart(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        shutil.copyfile(src, dest)
        return
    proc = subprocess.run(
        [ffmpeg, "-y", "-i", str(src), "-c", "copy", "-movflags", "+faststart", str(dest)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if proc.returncode != 0 or not dest.exists():
        shutil.copyfile(src, dest)


def upload_gcs(key: str, path: Path) -> None:
    bucket_name = os.environ.get("CLASSY_BUCKET", "").strip()
    if not bucket_name:
        return
    from google.cloud import storage

    storage.Client().bucket(bucket_name).blob(key).upload_from_filename(str(path))


def set_ingest(cur, video_id: str, state: str, detail: str = "", url: str = "") -> None:
    cur.execute(
        """
        INSERT INTO ingest (video_id, url, state, detail, updated_at)
        VALUES (%s, %s, %s, %s, now())
        ON CONFLICT (video_id) DO UPDATE
        SET state = EXCLUDED.state,
            detail = EXCLUDED.detail,
            url = CASE WHEN EXCLUDED.url <> '' THEN EXCLUDED.url ELSE ingest.url END,
            updated_at = now()
        """,
        (video_id, url, state, detail),
    )


@dataclass
class VideoRecord:
    """Everything one video contributes to a snapshot, independent of where it came from."""

    video_id: str
    clip: dict
    seconds: list[dict]
    chunks: list
    events: list[dict]
    activation: np.ndarray
    mp4: Path | None
    timing_candidate: bool
    url: str = ""


class LabFilesSource:
    """Videos from the lab's files: features/full CSVs, TRIBE activations and mp4s.

    A live-ingest source implements the same methods (ready, failed, timeline, events, meta,
    public, activation, mp4, timing_candidate) and build_video works unchanged.
    """

    def __init__(self, root: Path):
        loaded = lab_tables(root)
        if loaded is None:
            raise SystemExit(
                f"No Video Indexer timeline at {root / 'features' / 'full' / 'timeline.csv'}. Nothing packed."
            )
        timeline, events, self.video_meta, self.dataset = loaded
        self.root = root
        self.by_time: dict[str, list] = {}
        for row in timeline:
            self.by_time.setdefault(row["video_id"], []).append(row)
        self.by_event: dict[str, list] = {}
        for row in events:
            self.by_event.setdefault(row["video_id"], []).append(row)
        self.curves = curve_seconds(root)
        self.labels = load_yeo7_labels(ROOT / "reference" / "yeo2011", 20484 // 2)
        timeline_ids = {video_id for video_id in self.by_time if include_id(video_id)}
        self._ready, self._failed = set(), {}
        for video_id in timeline_ids:
            if activation_path(root, video_id):
                self._ready.add(video_id)
            else:
                error = tribe_error(root, video_id)
                if error:
                    self._failed[video_id] = error
        self.missing_curve = sorted(timeline_ids - self._ready - set(self._failed))

    def ready(self) -> list[str]:
        if self.missing_curve:
            raise SystemExit("Nothing packed. A timeline has no predicted curve: " + ", ".join(self.missing_curve))
        return sorted(self._ready)

    def failed(self) -> dict[str, str]:
        return dict(self._failed)

    def timeline(self, video_id: str) -> list[dict]:
        return self.by_time.get(video_id, [])

    def events(self, video_id: str) -> list[dict]:
        return self.by_event.get(video_id, [])

    def meta(self, video_id: str) -> dict:
        return self.video_meta.get(video_id, {})

    def public(self, video_id: str) -> dict:
        return self.dataset.get(video_id, {})

    def activation(self, video_id: str) -> np.ndarray:
        return np.load(activation_path(self.root, video_id))

    def mp4(self, video_id: str) -> Path | None:
        return find_mp4(self.root, video_id, self.public(video_id))

    def timing_candidate(self, video_id: str) -> bool:
        """Counts toward the timing set (exactly EXPECTED_TIMING in a snapshot turns cut sentences on)."""
        seconds = {int(float(row["t_sec"])) for row in self.timeline(video_id)}
        return bool(timing_set({video_id: self.public(video_id)}, {video_id: seconds}, self.curves))


_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
_FOLD = {
    "application": "app",
    "applications": "app",
    "apps": "app",
    "knows": "know",
    "knew": "know",
    "known": "know",
    "grades": "grade",
    "explains": "explain",
    "explained": "explain",
    "says": "say",
    "said": "say",
    "displays": "display",
    "displayed": "display",
}
_SCREEN = re.compile(r"on[-\s]?screen|\bspanish text\b|\btext (?:explains|says|displays)\b", re.I)
_STOP = {
    "a", "an", "the", "at", "in", "of", "to", "and", "or", "while", "with",
    "her", "his", "she", "he", "they", "is", "are", "was", "who", "now", "for",
}


def _tokens(text: str) -> list[str]:
    return [_FOLD.get(word, word) for word in _WORD.findall(str(text or "").lower())]


def _stored_sentences(scenes, outcomes) -> list[str]:
    ordered = []
    for source in ("content_understanding", "gemini"):
        for item in scenes or []:
            if (item or {}).get("source") == source:
                sentence = " ".join(str(item.get("sentence") or "").split())
                if sentence:
                    ordered.append(sentence)
    for item in scenes or []:
        if (item or {}).get("source") not in ("content_understanding", "gemini"):
            sentence = " ".join(str((item or {}).get("sentence") or "").split())
            if sentence:
                ordered.append(sentence)
    for item in outcomes or []:
        sentence = " ".join(str((item or {}).get("sentence") or "").split())
        if sentence:
            ordered.append(sentence)
    return ordered


def _clauses(sentence: str) -> list[tuple[str, bool]]:
    parts = re.split(r"\s+while\s+", sentence, maxsplit=1, flags=re.I)
    if len(parts) == 2 and _SCREEN.search(parts[1]):
        return [(parts[0], False), (parts[1], True)]
    return [(sentence, bool(_SCREEN.search(sentence)))]


def _content(text: str) -> set[str]:
    return {word for word in _tokens(text) if word not in _STOP}


def _already_said(text: str, kept: list[str]) -> bool:
    words = _tokens(text)
    folded = " ".join(words)
    if any(folded == " ".join(_tokens(prior)) for prior in kept):
        return True
    content = _content(text)
    seen = set()
    windows = []
    for prior in kept:
        seen |= _content(prior)
        windows.append(" ".join(_tokens(prior)))
    if content and seen and len(content & seen) / len(content) >= 0.6:
        return True
    if len(words) >= 4:
        for window in windows:
            for index in range(0, len(words) - 3):
                if " ".join(words[index:index + 4]) in window:
                    return True
    return False


def _finish(text: str) -> str:
    body = " ".join(str(text or "").split())
    if not body:
        return ""
    if body[0].islower():
        body = body[0].upper() + body[1:]
    if body[-1] not in ".!?":
        body += "."
    return body


def cohesive_text(scenes, outcomes) -> str:
    """One or two sentences from the stored scene and outcome lines, in time order.

    A later line that repeats an earlier fact is dropped. No word is added except a
    capital letter and a closing period. The stored sentences are not changed.
    """
    visual = []
    screen = []
    for sentence in _stored_sentences(scenes, outcomes):
        for clause, is_screen in _clauses(sentence):
            clause = " ".join(clause.split())
            if not clause or _already_said(clause, visual + screen):
                continue
            (screen if is_screen else visual).append(clause)
    parts = [_finish(" ".join(visual)), _finish(" ".join(screen))]
    return " ".join(part for part in parts if part)


def build_video(video_id: str, source) -> VideoRecord:
    """Read one video from `source` into a VideoRecord. No database, no files written."""
    if not include_id(video_id):
        raise SystemExit(f"{video_id} is excluded from the catalog.")
    act = source.activation(video_id)
    features = neural_features(act, None)
    events = source.events(video_id)
    seconds, cuts = build_seconds(source.timeline(video_id), events, {})
    for second in seconds:
        second["happens"] = cohesive_text(second.get("scenes") or [], second.get("outcomes") or [])
        second["speech_score"] = normalize_score(second.get("speech_score"))
        lines = second.get("text_on_screen") or []
        if isinstance(lines, list):
            for item in lines:
                if isinstance(item, dict):
                    item["score"] = normalize_score(item.get("score"))
    meta = source.meta(video_id)
    public = source.public(video_id)
    plays = as_float(public.get("views") or public.get("plays"))
    likes = as_float(public.get("likes"))
    followers = as_float(public.get("followers"))
    duration = (
        as_float(public.get("duration_s"))
        or as_float(meta.get("duration_sec"))
        or features["duration_sec"]
        or len(seconds)
    )
    chunks = chunks_for(
        seconds,
        {"topic": tag_names(meta.get("topics") or ""), "keyword": tag_names(meta.get("keywords") or "")},
        top_networks(act, source.labels),
        normalize_score,
    )
    clip = {
        "duration": duration,
        "language": meta.get("language") or "",
        "account": public.get("creator") or public.get("account") or "",
        "plays": plays,
        "likes": likes,
        "comments": as_float(public.get("comments")),
        "followers": followers,
        "like_rate": (likes / plays) if plays and likes is not None else None,
        "amplification": (plays / followers) if plays and followers else None,
        "hook_slope": features["hook_slope"],
        "peak_mean_abs": features["peak_mean_abs"],
        "sustain_ratio": features["sustain_ratio"],
        "cuts": cuts,
        "curve": features["activation_timeline"]["series"],
        "topics": meta.get("topics") or "",
        "keywords": meta.get("keywords") or "",
        "networks": network_record(act, source.labels),
    }
    return VideoRecord(
        video_id=video_id,
        clip=clip,
        seconds=seconds,
        chunks=chunks,
        events=events,
        activation=act,
        mp4=source.mp4(video_id),
        timing_candidate=source.timing_candidate(video_id),
        url=public.get("url") or "",
    )


def sprite_cache_dir() -> Path:
    return object_root() / "cache" / "frames"


def write_video(cur, snapshot_id: str, record: VideoRecord, store: Path) -> int:
    """Write one record into a snapshot: objects (mp4, activation, frames) and rows. Returns chunk count."""
    video_id = record.video_id
    prefix = f"snapshots/{snapshot_id}/{video_id}"
    mp4_key = sprite_key = ""
    sprite_meta = None
    if record.mp4:
        mp4_key = f"{prefix}.mp4"
        faststart(record.mp4, store / f"{video_id}.mp4")
        upload_gcs(mp4_key, store / f"{video_id}.mp4")
        try:
            sprite_meta = frames.build_sprite(
                store / f"{video_id}.mp4", store / f"{video_id}.frames.jpg", record.clip["duration"], sprite_cache_dir()
            )
            sprite_key = f"{prefix}.frames.jpg"
            upload_gcs(sprite_key, store / f"{video_id}.frames.jpg")
        except frames.FrameError as err:
            print(f"no frames for {video_id}: {err}", flush=True)
    act_key = f"{prefix}.bin"
    quantized, frame_count = quantize_activation(record.activation, 90)
    (store / f"{video_id}.bin").write_bytes(quantized.tobytes())
    upload_gcs(act_key, store / f"{video_id}.bin")
    c = record.clip
    cur.execute(
        """
        INSERT INTO clip (
          video_id, snapshot_id, duration, language, account,
          plays, likes, comments, followers, like_rate, amplification,
          hook_slope, peak_mean_abs, sustain_ratio, timing_eligible, timing_candidate, cuts, curve,
          mp4_object, act_object, frames, topics, keywords, sprite_object, sprite_meta, networks
        ) VALUES (
          %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s, %s,
          %s, %s, %s, false, %s, %s, %s,
          %s, %s, %s, %s, %s, %s, %s, %s
        )
        """,
        (
            video_id, snapshot_id, c["duration"], c["language"], c["account"],
            c["plays"], c["likes"], c["comments"], c["followers"], c["like_rate"], c["amplification"],
            c["hook_slope"], c["peak_mean_abs"], c["sustain_ratio"], record.timing_candidate, Json(c["cuts"]), Json(c["curve"]),
            mp4_key, act_key, frame_count, c["topics"], c["keywords"], sprite_key or None, Json(sprite_meta) if sprite_meta else None,
            Json(c["networks"]) if c.get("networks") else None,
        ),
    )
    execute_values(
        cur,
        """
        INSERT INTO second (
          video_id, snapshot_id, t_sec, speech, speech_score, text_on_screen, speaker,
          labels, face_count, music_score, sentiment, scenes, outcomes, app, ask, happens
        ) VALUES %s
        """,
        [
            (
                video_id,
                snapshot_id,
                row["t_sec"],
                row.get("speech") or "",
                row.get("speech_score"),
                Json(row.get("text_on_screen") or []),
                row.get("speaker") or "",
                Json(row.get("labels") or []),
                row.get("face_count"),
                normalize_score(row.get("music_score")),
                Json(row.get("sentiment")),
                Json(row.get("scenes") or []),
                Json(row.get("outcomes") or []),
                Json(row.get("app")),
                Json(row.get("ask")),
                row.get("happens") or None,
            )
            for row in record.seconds
        ],
    )
    if record.chunks:
        execute_values(
            cur,
            """
            INSERT INTO chunk (
              video_id, snapshot_id, t_sec, end_sec, field, text, confidence, speaker, language, context
            ) VALUES %s
            """,
            [
                (
                    video_id,
                    snapshot_id,
                    chunk.t_sec,
                    chunk.end_sec,
                    chunk.field,
                    chunk.text,
                    chunk.confidence,
                    chunk.speaker,
                    c["language"],
                    Json(chunk.context) if chunk.context else None,
                )
                for chunk in record.chunks
            ],
        )
    if record.events:
        execute_values(
            cur,
            """
            INSERT INTO event (video_id, snapshot_id, source, start_sec, end_sec, tags, text, evidence, score)
            VALUES %s
            """,
            [
                (
                    video_id,
                    snapshot_id,
                    event.get("source"),
                    as_float(event.get("start_sec")),
                    as_float(event.get("end_sec")),
                    Json(json_load(event.get("tags"), [])),
                    event.get("text") or "",
                    event.get("evidence") or "",
                    normalize_score(event.get("score")),
                )
                for event in record.events
            ],
        )
    return len(record.chunks)


def apply_timing_rule(cur, snapshot_id: str) -> bool:
    """Cut sentences attach only when this snapshot's timing set is exactly EXPECTED_TIMING."""
    cur.execute(
        "SELECT count(*) FROM clip WHERE snapshot_id = %s AND coalesce(timing_candidate, timing_eligible, false)",
        (snapshot_id,),
    )
    count = cur.fetchone()[0]
    attach = count == EXPECTED_TIMING
    cur.execute(
        """
        UPDATE clip SET timing_eligible = (%s AND coalesce(timing_candidate, timing_eligible, false))
        WHERE snapshot_id = %s
        """,
        (attach, snapshot_id),
    )
    if attach:
        print(f"Timing overlap is {EXPECTED_TIMING}. Cut sentences are on.", flush=True)
    else:
        print(f"Timing overlap is {count}, not {EXPECTED_TIMING}. Cut sentences stay off.", flush=True)
    return attach


def mark_repeats(cur, snapshot_id: str) -> int:
    """Flag every chunk that repeats an earlier second's line of the same video and field."""
    cur.execute(
        """
        UPDATE chunk k SET is_repeat = r.later
        FROM (
          SELECT id, row_number() OVER (PARTITION BY video_id, field, text ORDER BY t_sec, id) > 1 AS later
          FROM chunk WHERE snapshot_id = %s
        ) r
        WHERE k.id = r.id AND k.is_repeat IS DISTINCT FROM r.later
        """,
        (snapshot_id,),
    )
    return cur.rowcount


def new_snapshot(cur) -> tuple[str, Path]:
    stamp = datetime.now(timezone.utc).strftime("ku-%Y%m%dT%H%M%SZ")
    cur.execute("SELECT id FROM snapshot WHERE id = %s OR id LIKE %s", (stamp, f"{stamp}-%"))
    taken = {row[0] for row in cur.fetchall()}
    snapshot_id = next(sid for sid in [stamp, *(f"{stamp}-{n}" for n in range(2, 1000))] if sid not in taken)
    cur.execute(
        "INSERT INTO snapshot (id, complete, embedding_model, embedding_dim, quote_floor) VALUES (%s, false, NULL, NULL, %s)",
        (snapshot_id, QUOTE_FLOOR),
    )
    store = object_root() / "snapshots" / snapshot_id
    store.mkdir(parents=True, exist_ok=True)
    return snapshot_id, store


def pack_video(cur, snapshot_id: str, store: Path, video_id: str, source) -> None:
    started = time.monotonic()
    url = source.public(video_id).get("url") or ""
    set_ingest(cur, video_id, "packing", snapshot_id, url)
    record = build_video(video_id, source)
    count = write_video(cur, snapshot_id, record, store)
    set_ingest(cur, video_id, "validating", f"{snapshot_id} in {time.monotonic() - started:.1f}s", url)
    print(f"packed {video_id} seconds={len(record.seconds)} chunks={count} {time.monotonic() - started:.1f}s", flush=True)


def pack(conn, source, provider, *, allow_exact_only: bool = False) -> str:
    ready = source.ready()
    if not ready:
        raise SystemExit("No clip has both a Video Indexer timeline and a predicted curve. Nothing packed.")
    with conn.cursor() as cur:
        for video_id, error in sorted(source.failed().items()):
            set_ingest(cur, video_id, "failed", "TRIBE failed: " + error, source.public(video_id).get("url") or "")
            print(f"left out {video_id}: TRIBE failed", flush=True)
        snapshot_id, store = new_snapshot(cur)
        for video_id in ready:
            pack_video(cur, snapshot_id, store, video_id, source)
        apply_timing_rule(cur, snapshot_id)
        mark_repeats(cur, snapshot_id)
    conn.commit()
    print(f"{snapshot_id}: {len(ready)} videos written, not live. Embedding next.", flush=True)
    return finish(conn, snapshot_id, provider, allow_exact_only=allow_exact_only)


COPY_TABLES = ("clip", "second", "chunk", "event")
OBJECT_COLUMNS = ("mp4_object", "act_object", "sprite_object")


def table_columns(cur, table: str) -> list[str]:
    cur.execute(
        """
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s AND is_generated = 'NEVER'
        ORDER BY ordinal_position
        """,
        (table,),
    )
    return [row[0] for row in cur.fetchall() if row[0] not in ("id", "snapshot_id")]


def link_object(key: str, new_key: str) -> None:
    root = object_root()
    src, dest = root / key, root / new_key
    if src.is_file():
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.unlink(missing_ok=True)
        try:
            dest.hardlink_to(src)
        except OSError:
            shutil.copyfile(src, dest)
    bucket_name = os.environ.get("CLASSY_BUCKET", "").strip()
    if bucket_name:
        from google.cloud import storage

        bucket = storage.Client().bucket(bucket_name)
        blob = bucket.get_blob(key)
        if blob:
            bucket.copy_blob(blob, bucket, new_key)


def derive(conn, base_id: str, source, provider, *, add=(), drop=(), allow_exact_only: bool = False) -> str:
    """New snapshot = BASE minus `drop`, with `add` (re)packed from `source`. Never moves the pointer.

    Kept videos are copied row for row (vectors included) and their objects hardlinked, so
    only added videos cost TRIBE outputs, frames and embeddings.
    """
    add = sorted(set(add))
    drop = set(drop)
    bad = [video_id for video_id in add if not include_id(video_id)]
    if bad:
        raise SystemExit(f"Excluded ids cannot be added: {', '.join(bad)}")
    with conn.cursor() as cur:
        cur.execute("SELECT complete, embedding_profile FROM snapshot WHERE id = %s", (base_id,))
        row = cur.fetchone()
        if not row or not row[0]:
            raise SystemExit(f"{base_id} is not a complete snapshot.")
        base_profile = row[1]
        cur.execute("SELECT video_id FROM clip WHERE snapshot_id = %s", (base_id,))
        base_ids = {r[0] for r in cur.fetchall()}
        unknown = sorted(drop - base_ids)
        if unknown:
            print(f"not in {base_id}, nothing to drop: {', '.join(unknown)}", flush=True)
        ready = set(source.ready()) if add else set()
        missing = [video_id for video_id in add if video_id not in ready]
        if missing:
            raise SystemExit(f"No timeline and curve for: {', '.join(missing)}. Nothing derived.")
        keep = sorted(video_id for video_id in base_ids - drop - set(add) if include_id(video_id))
        snapshot_id, store = new_snapshot(cur)
        old_prefix, new_prefix = f"snapshots/{base_id}/", f"snapshots/{snapshot_id}/"
        for table in COPY_TABLES:
            cols = table_columns(cur, table)
            select = [
                f"replace({col}, %(old)s, %(new)s)" if table == "clip" and col in OBJECT_COLUMNS else col for col in cols
            ]
            cur.execute(
                f"INSERT INTO {table} (snapshot_id, {', '.join(cols)}) "
                f"SELECT %(sid)s, {', '.join(select)} FROM {table} WHERE snapshot_id = %(base)s AND video_id = ANY(%(keep)s)",
                {"sid": snapshot_id, "base": base_id, "keep": keep, "old": old_prefix, "new": new_prefix},
            )
        cur.execute(
            f"SELECT {', '.join(OBJECT_COLUMNS)} FROM clip WHERE snapshot_id = %s AND video_id = ANY(%s)",
            (base_id, keep),
        )
        for keys in cur.fetchall():
            for key in keys:
                if key:
                    link_object(key, key.replace(old_prefix, new_prefix, 1))
        print(f"{snapshot_id}: copied {len(keep)} videos from {base_id}", flush=True)
        for video_id in add:
            pack_video(cur, snapshot_id, store, video_id, source)
        apply_timing_rule(cur, snapshot_id)
        mark_repeats(cur, snapshot_id)
    conn.commit()
    only_missing = bool(base_profile) and base_profile == provider.profile
    return finish(conn, snapshot_id, provider, allow_exact_only=allow_exact_only, only_missing=only_missing)


def finish(conn, snapshot_id: str, provider, *, allow_exact_only: bool = False, only_missing: bool = False) -> str:
    """Embed an incomplete snapshot's chunks and mark it complete. Never moves the pointer."""
    with conn.cursor() as cur:
        cur.execute("SELECT complete FROM snapshot WHERE id = %s", (snapshot_id,))
        row = cur.fetchone()
        cur.execute("SELECT count(*) FROM clip WHERE snapshot_id = %s", (snapshot_id,))
        videos = cur.fetchone()[0]
    conn.commit()
    if row is None:
        raise SystemExit(f"No snapshot {snapshot_id}.")
    if row[0]:
        raise SystemExit(f"{snapshot_id} is already complete.")
    embedded = embed_snapshot(conn, snapshot_id, provider, allow_exact_only=allow_exact_only, only_missing=only_missing)
    with conn.cursor() as cur:
        cur.execute("UPDATE snapshot SET complete = true WHERE id = %s", (snapshot_id,))
    conn.commit()
    print(
        f"{snapshot_id} is complete and not live. {videos} videos, {embedded} chunks with vectors.\n"
        f"Next: pack_snapshot.py --validate {snapshot_id}, then --promote {snapshot_id}.",
        flush=True,
    )
    return snapshot_id


def embed_snapshot(conn, snapshot_id: str, provider, *, allow_exact_only: bool = False, only_missing: bool = False) -> int:
    """Attach a vector to every chunk of the snapshot (or only chunks without one), through embedding_cache."""
    if not provider.configured:
        if allow_exact_only:
            print("No embedding key. Snapshot stays exact-only (--allow-exact-only).", flush=True)
            return 0
        raise SystemExit(
            f"No key for {provider.profile}. {snapshot_id} stays incomplete and is never served. "
            "Set the key and re-run, or pass --allow-exact-only."
        )
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT text FROM chunk WHERE snapshot_id = %s AND (embedding IS NULL OR NOT %s)",
            (snapshot_id, only_missing),
        )
        raw = [row[0] for row in cur.fetchall()]
    conn.commit()
    try:
        vectors = embed_with_cache(conn, provider, raw, log=lambda line: print(line, flush=True))
    except EmbeddingError as err:
        conn.rollback()
        raise SystemExit(
            f"Embedding failed ({err}). {snapshot_id} stays incomplete and is never served. "
            "Re-running the pack reuses every vector already cached."
        ) from None
    pairs = [
        (hashlib.md5(text.encode("utf-8")).hexdigest(), vectors[format_document(text)])
        for text in raw
        if format_document(text) in vectors
    ]
    with conn.cursor() as cur:
        # Keyed by md5: long chunk texts exceed the btree row limit.
        cur.execute("CREATE TEMP TABLE pack_vectors (text_md5 text PRIMARY KEY, vector vector) ON COMMIT DROP")
        execute_values(
            cur, "INSERT INTO pack_vectors (text_md5, vector) VALUES %s", pairs, template="(%s, %s::vector)"
        )
        cur.execute(
            """
            UPDATE chunk k SET embedding = v.vector, model = %s, dimension = %s
            FROM pack_vectors v
            WHERE k.snapshot_id = %s AND md5(k.text) = v.text_md5 AND (k.embedding IS NULL OR NOT %s)
            """,
            (provider.model, provider.dim, snapshot_id, only_missing),
        )
        updated = cur.rowcount
        if only_missing:
            cur.execute("SELECT count(*) FROM chunk WHERE snapshot_id = %s AND embedding IS NOT NULL", (snapshot_id,))
            updated = cur.fetchone()[0]
        cur.execute(
            "UPDATE snapshot SET embedding_model = %s, embedding_dim = %s, embedding_profile = %s WHERE id = %s",
            (provider.model, provider.dim, provider.profile, snapshot_id),
        )
    conn.commit()
    return updated


def self_check() -> None:
    assert include_id("v002")
    assert not include_id("A_V1")
    assert not include_id("v019")
    assert normalize_score(80) == 0.8
    assert normalize_score(0.4) == 0.4
    assert normalize_score(None) is None
    timeline_ids = {"v002", "v005"}
    curve_ids = {"v002"}
    missing = sorted(timeline_ids - curve_ids)
    assert missing == ["v005"]
    ready = sorted(timeline_ids & curve_ids)
    assert ready == ["v002"]
    seconds8 = set(range(8))
    dataset = {
        "v002": {"save_model": "1"},
        "v006": {"save_model": "0"},
        "v008": {"save_model": "1"},
    }
    picked = timing_set(
        dataset,
        {"v002": seconds8, "v006": seconds8, "v008": set(range(7))},
        {"v002": seconds8, "v006": seconds8, "v008": seconds8},
    )
    assert picked == ["v002"]
    assert timing_set(dataset, {"v002": seconds8}, {}) == []
    assert (len(["x"] * 78) == EXPECTED_TIMING) is True
    assert (len(["x"] * 83) == EXPECTED_TIMING) is False
    print("self-check ok")


def load_env_file(path: Path) -> None:
    """Fill missing environment variables from web/.env.local (never overrides)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def golden_evaluator():
    """recall tables for one snapshot, hybrid mode, from catalog/eval/run.py."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("classy_eval_run", ROOT / "catalog" / "eval" / "run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def evaluate(snapshot_id: str) -> dict:
        return module.evaluate(snapshot_id, modes=("auto",))["auto"]["table"]

    return evaluate


def go_live(conn, snapshot_id: str, reason: str, gate_kwargs: dict, failed_on_gate=()) -> None:
    """Promote through the gate; every video in the promoted snapshot becomes live."""
    try:
        report = gate.promote(conn, snapshot_id, reason=reason, evaluate=golden_evaluator(), **gate_kwargs)
    except gate.GateError as err:
        with conn.cursor() as cur:
            for video_id in failed_on_gate:
                set_ingest(cur, video_id, "failed", f"{snapshot_id} did not pass the gate")
        conn.commit()
        raise SystemExit(f"Not promoted.\n{err}") from None
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest SET state = 'live', detail = %s, updated_at = now()
            WHERE video_id IN (SELECT video_id FROM clip WHERE snapshot_id = %s) AND state <> 'blocked'
            """,
            (snapshot_id, snapshot_id),
        )
    conn.commit()
    print(report.render())
    print(f"Live snapshot is {snapshot_id}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--finish", metavar="SNAPSHOT_ID", help="Embed and complete a snapshot whose pack stopped")
    action.add_argument("--derive", metavar="BASE_ID", help="New snapshot from BASE with --add and --drop applied")
    action.add_argument("--validate", metavar="SNAPSHOT_ID")
    action.add_argument("--promote", metavar="SNAPSHOT_ID")
    action.add_argument("--rollback", action="store_true")
    action.add_argument("--prune", action="store_true")
    action.add_argument("--self-check", action="store_true")
    parser.add_argument(
        "--allow-exact-only",
        action="store_true",
        help="Accept a snapshot without vectors (search shows exact matches only)",
    )
    parser.add_argument("--reason", default="promote", help="Recorded in pointer_history")
    parser.add_argument("--add", action="append", default=[], metavar="VIDEO_ID", help="With --derive: pack this video")
    parser.add_argument("--drop", action="append", default=[], metavar="VIDEO_ID", help="With --derive: leave this video out")
    parser.add_argument("--live", action="store_true", help="With --derive: promote when every check passes")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    load_env_file(ROOT / "web" / ".env.local")
    provider = get_document_provider()
    conn = psycopg2.connect(database_url())
    try:
        apply_schema(conn)
        gate_kwargs = {
            "profile": provider.profile,
            "object_root": object_root(),
            "allow_exact_only": args.allow_exact_only,
        }
        if args.finish:
            finish(conn, args.finish, provider, allow_exact_only=args.allow_exact_only)
            return
        if args.derive:
            if not args.add and not args.drop:
                raise SystemExit("--derive needs at least one --add or --drop.")
            source = LabFilesSource(resolve_lab_root()) if args.add else None
            snapshot_id = derive(
                conn, args.derive, source, provider, add=args.add, drop=args.drop, allow_exact_only=args.allow_exact_only
            )
            if not args.live:
                report = gate.validate(conn, snapshot_id, evaluate=golden_evaluator(), **gate_kwargs)
                print(report.render())
                raise SystemExit(0 if report.ok else 1)
            go_live(conn, snapshot_id, f"derive {args.derive} +{','.join(args.add)} -{','.join(args.drop)}", gate_kwargs, args.add)
            return
        if args.validate:
            report = gate.validate(conn, args.validate, evaluate=golden_evaluator(), **gate_kwargs)
            print(report.render())
            raise SystemExit(0 if report.ok else 1)
        if args.promote:
            go_live(conn, args.promote, args.reason, gate_kwargs)
            return
        if args.rollback:
            try:
                before, after = gate.rollback(conn)
            except gate.GateError as err:
                raise SystemExit(f"Not rolled back: {err}") from None
            print(f"Rolled back from {before} to {after}.")
            return
        if args.prune:
            removed = gate.prune(conn, object_root())
            print("Removed: " + (", ".join(removed) if removed else "nothing"))
            return
        root = resolve_lab_root()
        if root is None:
            raise SystemExit("Lab root has no features/full/timeline.csv. Set VIRALITY_ROOT. Nothing packed.")
        pack(conn, LabFilesSource(root), provider, allow_exact_only=args.allow_exact_only)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
