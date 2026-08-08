#!/usr/bin/env python3
"""Build Classy content_events.json (speech, OCR text, scene cuts) per reel."""

from __future__ import annotations

import argparse
import difflib
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import whisper


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalized_text(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def text_quality(text: str) -> tuple[int, int]:
    normalized = normalized_text(text)
    return len(set(normalized.split())), len(normalized)


def similar_text(left: str, right: str) -> bool:
    a = normalized_text(left)
    b = normalized_text(right)
    if not a or not b:
        return False
    if difflib.SequenceMatcher(None, a, b).ratio() >= 0.82:
        return True
    a_tokens = {token for token in a.split() if len(token) > 1}
    b_tokens = {token for token in b.split() if len(token) > 1}
    if min(len(a_tokens), len(b_tokens)) < 4:
        return False
    overlap = len(a_tokens & b_tokens) / min(len(a_tokens), len(b_tokens))
    return overlap >= 0.75


def tesseract_text(frame: np.ndarray, command: str) -> str:
    height, width = frame.shape[:2]
    scale = max(1.5, 1200 / max(width, height))
    resized = cv2.resize(
        frame,
        None,
        fx=scale,
        fy=scale,
        interpolation=cv2.INTER_CUBIC,
    )
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    binary = cv2.threshold(gray, 175, 255, cv2.THRESH_BINARY)[1]
    ok, encoded = cv2.imencode(".png", binary)
    if not ok:
        return ""

    proc = subprocess.run(
        [command, "stdin", "stdout", "-l", "eng", "--psm", "11", "tsv"],
        input=encoded.tobytes(),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=True,
    )

    lines_by_id: dict[tuple[int, int, int], list[tuple[int, float, str]]] = {}
    lines = proc.stdout.decode("utf-8", errors="ignore").splitlines()
    if not lines:
        return ""
    headers = lines[0].split("\t")
    for line in lines[1:]:
        values = line.split("\t")
        if len(values) != len(headers):
            continue
        row = dict(zip(headers, values))
        text = clean_text(row.get("text", ""))
        if not text:
            continue
        try:
            confidence = float(row.get("conf", "-1"))
        except ValueError:
            continue
        if confidence < 50:
            continue
        if not any(char.isalnum() for char in text):
            continue
        if len(text) == 1 and text.lower() not in {"a", "i"}:
            continue
        line_id = (
            int(row.get("block_num", 0)),
            int(row.get("par_num", 0)),
            int(row.get("line_num", 0)),
        )
        lines_by_id.setdefault(line_id, []).append(
            (int(row.get("word_num", 0)), confidence, text)
        )

    kept_lines = []
    for line_id in sorted(lines_by_id):
        words = sorted(lines_by_id[line_id])
        line = clean_text(" ".join(word[2] for word in words))
        alnum_count = sum(char.isalnum() for char in line)
        if alnum_count < 4:
            continue
        if len(words) == 1 and len(normalized_text(line)) < 5:
            continue
        kept_lines.append(line)
    return clean_text(" ".join(kept_lines))


def extract_ocr(
    video_path: Path,
    timestamps: np.ndarray,
    tesseract_command: str,
) -> list[dict]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Unable to open {video_path}")

    events: list[dict] = []
    last_text = ""
    try:
        for timestamp in timestamps:
            t_sec = float(timestamp)
            capture.set(cv2.CAP_PROP_POS_MSEC, t_sec * 1000)
            ok, frame = capture.read()
            if not ok:
                continue
            text = tesseract_text(frame, tesseract_command)
            if not text:
                last_text = ""
                continue
            if last_text and similar_text(last_text, text):
                if text_quality(text) > text_quality(last_text):
                    events[-1]["content"] = text
                    last_text = text
                continue
            events.append(
                {
                    "t_sec": round(t_sec, 3),
                    "type": "text_overlay",
                    "content": text,
                }
            )
            last_text = text
    finally:
        capture.release()
    return events


def extract_speech(model, video_path: Path) -> list[dict]:
    result = model.transcribe(
        str(video_path),
        language="en",
        task="transcribe",
        fp16=False,
        word_timestamps=False,
        verbose=False,
        condition_on_previous_text=True,
    )
    events = []
    for segment in result.get("segments", []):
        text = clean_text(segment.get("text", ""))
        if not text or float(segment.get("no_speech_prob", 0)) >= 0.7:
            continue
        events.append(
            {
                "t_sec": round(float(segment["start"]), 3),
                "type": "speech",
                "content": text,
            }
        )
    return events


def extract_scene_changes(
    video_path: Path,
    ffmpeg_command: str,
    threshold: float,
) -> list[dict]:
    expression = f"select='gt(scene,{threshold})',showinfo"
    proc = subprocess.run(
        [
            ffmpeg_command,
            "-hide_banner",
            "-nostats",
            "-i",
            str(video_path),
            "-an",
            "-vf",
            expression,
            "-f",
            "null",
            "-",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[-500:])

    events = []
    last_t = -1.0
    for value in re.findall(r"pts_time:([0-9.]+)", proc.stderr):
        t_sec = float(value)
        if t_sec <= 0.05 or t_sec - last_t < 0.4:
            continue
        events.append({"t_sec": round(t_sec, 3), "type": "scene_change"})
        last_t = t_sec
    return events


def load_whisper_model(name: str):
    preferred = "mps" if torch.backends.mps.is_available() else "cpu"
    try:
        return whisper.load_model(name, device=preferred), preferred
    except (RuntimeError, NotImplementedError):
        if preferred == "cpu":
            raise
        return whisper.load_model(name, device="cpu"), "cpu"


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--videos", type=Path, default=root / "videos")
    parser.add_argument("--outputs", type=Path, default=root / "outputs")
    parser.add_argument("--model", default="base")
    parser.add_argument("--scene-threshold", type=float, default=0.3)
    parser.add_argument("--only", nargs="*", default=None)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ffmpeg_command = shutil.which("ffmpeg")
    tesseract_command = shutil.which("tesseract")
    if not ffmpeg_command or not tesseract_command:
        raise SystemExit("ffmpeg and tesseract must be installed")

    videos = sorted(args.videos.glob("[AB]_V*.mp4"))
    if args.only:
        allowed = set(args.only)
        videos = [path for path in videos if path.stem in allowed]
    if not videos:
        raise SystemExit(f"No matching videos in {args.videos}")

    model, device = load_whisper_model(args.model)
    print(f"Whisper model={args.model} device={device}", flush=True)

    report = []
    for video_path in videos:
        video_id = video_path.stem
        output_dir = args.outputs / video_id
        timestamps_path = output_dir / "timestamps.npy"
        if not timestamps_path.exists():
            raise RuntimeError(f"Missing {timestamps_path}")
        target = output_dir / "content_events.json"
        if target.exists() and not args.force:
            print(f"{video_id}: exists (use --force to replace)", flush=True)
            continue

        started = time.perf_counter()

        stage = time.perf_counter()
        speech = extract_speech(model, video_path)
        speech_seconds = time.perf_counter() - stage

        timestamps = np.load(timestamps_path)
        stage = time.perf_counter()
        overlays = extract_ocr(video_path, timestamps, tesseract_command)
        ocr_seconds = time.perf_counter() - stage

        stage = time.perf_counter()
        scenes = extract_scene_changes(
            video_path,
            ffmpeg_command,
            args.scene_threshold,
        )
        scene_seconds = time.perf_counter() - stage

        events = speech + overlays + scenes
        events.sort(key=lambda item: (item["t_sec"], item["type"]))
        target.write_text(json.dumps(events, indent=2) + "\n")

        elapsed = time.perf_counter() - started
        item = {
            "video_id": video_id,
            "elapsed_sec": round(elapsed, 2),
            "speech_sec": round(speech_seconds, 2),
            "ocr_sec": round(ocr_seconds, 2),
            "scene_sec": round(scene_seconds, 2),
            "speech_events": len(speech),
            "text_overlay_events": len(overlays),
            "scene_change_events": len(scenes),
        }
        report.append(item)
        print(json.dumps(item), flush=True)

    print(json.dumps({"device": device, "videos": report}, indent=2), flush=True)


if __name__ == "__main__":
    main()
