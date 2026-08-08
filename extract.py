import csv
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from tribev2 import TribeModel
from tribev2.demo_utils import get_audio_and_text_events

N_VERTICES = 20484
MODEL_ID = "facebook/tribev2"
ROOT = Path(__file__).resolve().parent
VIDEO_DIR = ROOT / "videos"
OUTPUT_DIR = ROOT / "outputs"
CACHE_DIR = ROOT / "tribe_cache"
METADATA_CSV = ROOT / "metadata.csv"


def load_metadata():
    if not METADATA_CSV.exists():
        return {}
    with open(METADATA_CSV, newline="") as f:
        return {r["video_id"]: r for r in csv.DictReader(f)}


def _int(x):
    x = str(x).strip()
    return int(x) if x else None


def _float(x):
    x = str(x).strip()
    return float(x) if x else None


def build_metadata_fields(info):
    followers = _int(info.get("followers"))
    plays = _int(info.get("plays"))
    views = _int(info.get("views"))
    likes = _int(info.get("likes"))
    comments = _int(info.get("comments"))
    like_rate = round(likes / plays, 6) if likes is not None and plays else None
    amplification = round(plays / followers, 4) if plays is not None and followers else None
    return {
        "account": info.get("account", ""),
        "url": info.get("url", ""),
        "followers": followers,
        "posted_at": info.get("posted_at", ""),
        "captured_at": info.get("captured_at", ""),
        "video_duration_sec": _float(info.get("duration_sec")),
        "metrics": {
            "plays": plays,
            "views": views,
            "likes": likes,
            "comments": comments,
            "like_rate": like_rate,
            "amplification": amplification,
        },
        "annotations": {
            "format": info.get("format", ""),
            "key_elements": info.get("key_elements", ""),
            "relatability_hook": info.get("relatability_hook", ""),
        },
    }


def pick_device():
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(device):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return TribeModel.from_pretrained(
        MODEL_ID,
        cache_folder=str(CACHE_DIR),
        device=device,
        config_update={
            "data.audio_feature.device": device,
            "data.video_feature.image.device": device,
            "data.text_feature.device": device,
        },
    )


def extract(model, video_path):
    event = {
        "type": "Video",
        "filepath": str(video_path),
        "start": 0,
        "timeline": "default",
        "subject": "default",
    }
    events = get_audio_and_text_events(pd.DataFrame([event]), audio_only=True)
    preds, segments = model.predict(events, verbose=False)

    activation = np.asarray(preds, dtype=np.float32)
    if activation.shape[0] == N_VERTICES:
        activation = activation.T
    if activation.shape[1] != N_VERTICES:
        raise RuntimeError(f"expected {N_VERTICES} vertices, got {activation.shape}")
    activation = activation.T

    timestamps = np.asarray([float(s.start) for s in segments], dtype=np.float32)
    if timestamps.shape[0] != activation.shape[1]:
        timestamps = np.arange(activation.shape[1], dtype=np.float32)
    return activation, timestamps


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    videos = sorted(VIDEO_DIR.glob("[AB]_V*.mp4"))
    if not videos:
        raise SystemExit(f"no videos in {VIDEO_DIR}")

    device = pick_device()
    metadata = load_metadata()
    model = load_model(device)

    for path in videos:
        vid = path.stem
        out_dir = OUTPUT_DIR / vid
        out_dir.mkdir(parents=True, exist_ok=True)
        info = metadata.get(vid, {})

        activation, timestamps = extract(model, path)
        np.save(out_dir / "activation.npy", activation)
        np.save(out_dir / "timestamps.npy", timestamps)
        meta = {
            "video_id": vid,
            "source_file": path.name,
            "model_id": MODEL_ID,
            "device": device,
            "vertices": int(activation.shape[0]),
            "time_steps": int(activation.shape[1]),
            "duration_sec": float(timestamps[-1]) if timestamps.size else 0.0,
        }
        meta.update(build_metadata_fields(info))
        (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
        print(f"{vid}: {activation.shape[0]}x{activation.shape[1]} saved", flush=True)


if __name__ == "__main__":
    main()
