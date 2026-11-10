"""Sprite grid math, the cell lookup shared with the web, and one real ffmpeg render."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
ROOT = CATALOG.parent
sys.path.insert(0, str(CATALOG))

import frames  # noqa: E402
import gate  # noqa: E402


class GridTest(unittest.TestCase):
    def test_short_video_one_frame_per_second(self):
        meta = frames.sprite_grid(37.0)
        self.assertEqual(meta["count"], 37)
        self.assertEqual(meta["interval"], 1.0)
        self.assertEqual((meta["cols"], meta["rows"]), (10, 4))
        self.assertTrue(gate.sprite_ok(meta))

    def test_partial_last_second_gets_a_frame(self):
        self.assertEqual(frames.sprite_grid(37.4)["count"], 38)

    def test_long_video_is_capped(self):
        meta = frames.sprite_grid(600.0)
        self.assertEqual(meta["count"], frames.MAX_FRAMES)
        self.assertEqual(meta["interval"], 5.0)
        self.assertEqual(meta["rows"], 12)

    def test_tiny_and_missing_durations(self):
        for duration in (0, None, 0.3):
            meta = frames.sprite_grid(duration)
            self.assertEqual((meta["count"], meta["cols"], meta["rows"]), (1, 1, 1))

    def test_cell_lookup_clamps_and_rounds_half_up(self):
        meta = frames.sprite_grid(37.0)
        self.assertEqual(frames.frame_cell(meta, 0), (0, 0))
        self.assertEqual(frames.frame_cell(meta, 12.4), (2, 1))
        self.assertEqual(frames.frame_cell(meta, 12.5), (3, 1))
        self.assertEqual(frames.frame_cell(meta, -3), (0, 0))
        self.assertEqual(frames.frame_cell(meta, 999), (6, 3))

    def test_web_lookup_matches(self):
        meta = frames.sprite_grid(600.0)
        times = [0, 2.5, 7.5, 12.49, 301, 599, 1200]
        script = (
            "const { frameOf } = await import('./server/search/frames.js');"
            f"const meta = {json.dumps(meta)};"
            f"process.stdout.write(JSON.stringify({json.dumps(times)}.map((t) => frameOf(meta, t))));"
        )
        out = subprocess.run(
            ["node", "--input-type=module", "-e", script], cwd=ROOT / "web", capture_output=True, text=True, check=True
        )
        web = [(cell["col"], cell["row"]) for cell in json.loads(out.stdout)]
        self.assertEqual(web, [frames.frame_cell(meta, t) for t in times])

    def test_gate_rejects_bad_grids(self):
        good = frames.sprite_grid(20)
        self.assertFalse(gate.sprite_ok(None))
        self.assertFalse(gate.sprite_ok({**good, "count": good["cols"] * good["rows"] + 1}))
        self.assertFalse(gate.sprite_ok({**good, "interval": 0}))
        self.assertFalse(gate.sprite_ok({"cols": 2}))


@unittest.skipIf(shutil.which("ffmpeg") is None, "ffmpeg not installed")
class RenderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.mp4 = self.tmp / "clip.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=5:size=320x568:rate=10",
             "-pix_fmt", "yuv420p", str(self.mp4)],
            check=True,
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_sprite_size_and_cache(self):
        cache = self.tmp / "cache"
        dest = self.tmp / "snap" / "clip.frames.jpg"
        meta = frames.build_sprite(self.mp4, dest, 5.0, cache)
        self.assertEqual((meta["count"], meta["cols"], meta["rows"]), (5, 5, 1))
        width, height = image_size(dest)
        self.assertEqual((width, height), (5 * frames.WIDTH, frames.HEIGHT))

        cached = next(cache.glob("*.jpg"))
        mtime = cached.stat().st_mtime_ns
        again = self.tmp / "snap2" / "clip.frames.jpg"
        self.assertEqual(frames.build_sprite(self.mp4, again, 5.0, cache), meta)
        self.assertEqual(cached.stat().st_mtime_ns, mtime)
        self.assertEqual(again.read_bytes(), dest.read_bytes())

    def test_broken_video_raises(self):
        bad = self.tmp / "bad.mp4"
        bad.write_bytes(b"not a video")
        with self.assertRaises(frames.FrameError):
            frames.build_sprite(bad, self.tmp / "out.jpg", 5.0, self.tmp / "cache")
        self.assertFalse(any((self.tmp / "cache").glob("*.jpg")))


def image_size(path: Path) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    width, height = out.stdout.strip().split(",")
    return int(width), int(height)


if __name__ == "__main__":
    os.environ.setdefault("CLASSY_LOG", "off")
    unittest.main()
