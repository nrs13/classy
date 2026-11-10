"""Frame sprite per video: evenly spaced frames tiled into one JPEG.

Search results show the frame at each moment without loading the video. Frame i is the
frame at i * interval seconds; the web reads the cell from sprite_meta:

  {"cols": 10, "rows": 4, "count": 37, "interval": 1.0, "width": 96, "height": 170}

Sprites are cached by the mp4's content hash, so repacking an unchanged video is free.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import subprocess
from pathlib import Path

MAX_FRAMES = 120
WIDTH = 96
HEIGHT = 170
COLS = 10
QUALITY = 7  # ffmpeg -q:v, 2 (best) to 31


class FrameError(RuntimeError):
    pass


def sprite_grid(duration: float, max_frames: int = MAX_FRAMES, cols: int = COLS) -> dict:
    """Frame count, spacing and grid for a video of `duration` seconds."""
    duration = max(float(duration or 0), 1.0)
    interval = max(1.0, duration / max_frames)
    count = max(1, min(max_frames, int(math.ceil(duration / interval - 1e-6))))
    interval = round(interval, 3)
    use_cols = min(cols, count)
    return {
        "cols": use_cols,
        "rows": int(math.ceil(count / use_cols)),
        "count": count,
        "interval": interval,
        "width": WIDTH,
        "height": HEIGHT,
    }


def frame_cell(meta: dict, t_sec: float) -> tuple[int, int]:
    """(col, row) of the frame shown for second `t_sec`; mirrors web/server/search/frames.js."""
    index = min(meta["count"] - 1, int(math.floor(max(0.0, float(t_sec)) / meta["interval"] + 0.5)))
    return index % meta["cols"], index // meta["cols"]


def file_hash(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise FrameError("ffmpeg is not installed")
    return ffmpeg


def render_sprite(mp4: Path, dest: Path, meta: dict) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    w, h = meta["width"], meta["height"]
    vf = (
        f"fps=1/{meta['interval']}:round=down,"
        f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
        f"tile={meta['cols']}x{meta['rows']}"
    )
    tmp = dest.with_suffix(".tmp.jpg")
    proc = subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-i", str(mp4), "-vf", vf, "-frames:v", "1", "-q:v", str(QUALITY), str(tmp)],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise FrameError(f"ffmpeg could not render frames for {mp4.name}: {proc.stderr.strip()[:300]}")
    tmp.replace(dest)


def build_sprite(mp4: Path, dest: Path, duration: float, cache_dir: Path) -> dict:
    """Write the sprite for `mp4` to `dest` and return its meta, reusing the cache when possible."""
    meta = sprite_grid(duration)
    key = f"{file_hash(mp4)}-{meta['count']}x{meta['interval']}-{WIDTH}x{HEIGHT}-q{QUALITY}"
    cached = cache_dir / f"{key}.jpg"
    if not cached.exists():
        render_sprite(mp4, cached, meta)
        cached.with_suffix(".json").write_text(json.dumps(meta))
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    try:
        dest.hardlink_to(cached)
    except OSError:
        shutil.copyfile(cached, dest)
    return meta
