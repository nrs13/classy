"""Promote and rollback against a throwaway Postgres database with two fixture snapshots."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
ROOT = CATALOG.parent
sys.path.insert(0, str(CATALOG))

import gate  # noqa: E402

try:
    import psycopg2
except ImportError:  # pragma: no cover
    psycopg2 = None

DB = f"classy_gate_test_{os.getpid()}"
PROFILE = "test|p|4|document"
UNIT = "[1,0,0,0]"
SPRITE = {"cols": 2, "rows": 1, "count": 2, "interval": 1.0, "width": 96, "height": 170}


def admin():
    conn = psycopg2.connect("postgresql:///postgres")
    conn.autocommit = True
    return conn


@unittest.skipIf(psycopg2 is None, "psycopg2 not installed")
class GateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            with admin().cursor() as cur:
                cur.execute(f"DROP DATABASE IF EXISTS {DB}")
                cur.execute(f"CREATE DATABASE {DB}")
        except psycopg2.OperationalError as err:  # pragma: no cover
            raise unittest.SkipTest(f"Postgres not available: {err}")
        cls.url = f"postgresql:///{DB}"
        cls.conn = psycopg2.connect(cls.url)
        with cls.conn.cursor() as cur:
            cur.execute((CATALOG / "schema.sql").read_text())
        cls.conn.commit()
        cls.objects = Path(tempfile.mkdtemp())
        for sid in ("snap-a", "snap-b"):
            cls.add_snapshot(sid)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        with admin().cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS {DB} WITH (FORCE)")

    @classmethod
    def add_snapshot(cls, sid, *, video="v001", vector=UNIT, timing=False, write_objects=True, sprite=True):
        with cls.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO snapshot (id, complete, embedding_model, embedding_dim, embedding_profile) "
                "VALUES (%s, true, 'test-model', 4, %s)",
                (sid, PROFILE),
            )
            mp4 = f"snapshots/{sid}/{video}.mp4"
            act = f"snapshots/{sid}/{video}.bin"
            sprite_key = f"snapshots/{sid}/{video}.frames.jpg" if sprite else None
            sprite_meta = json.dumps(SPRITE) if sprite else None
            cur.execute(
                "INSERT INTO clip (video_id, snapshot_id, language, account, curve, mp4_object, act_object, "
                "timing_eligible, sprite_object, sprite_meta) "
                "VALUES (%s, %s, 'en-US', 'acct', '[0.1, 0.2]', %s, %s, %s, %s, %s)",
                (video, sid, mp4, act, timing, sprite_key, sprite_meta),
            )
            cur.execute(
                "INSERT INTO second (video_id, snapshot_id, t_sec, speech) VALUES (%s, %s, 0, 'hello there')",
                (video, sid),
            )
            cur.execute(
                "INSERT INTO chunk (video_id, snapshot_id, t_sec, field, text, embedding) "
                "VALUES (%s, %s, 0, 'speech', 'hello there', %s::vector)",
                (video, sid, vector),
            )
        cls.conn.commit()
        if write_objects:
            for key in (mp4, act, sprite_key):
                if not key:
                    continue
                path = cls.objects / key
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x")

    def validate(self, sid, **kwargs):
        options = {"profile": PROFILE, "object_root": self.objects, "baseline_path": Path("/nonexistent")}
        options.update(kwargs)
        return gate.validate(self.conn, sid, **options)

    def pointer(self):
        with self.conn.cursor() as cur:
            value = gate.current_pointer(cur)
        self.conn.commit()
        return value

    def history(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT from_snapshot, to_snapshot, reason FROM pointer_history ORDER BY id")
            rows = cur.fetchall()
        self.conn.commit()
        return rows

    def catalog_snapshot(self):
        script = (
            "const { default: handler } = await import('./api/catalog.js');"
            "const { closePool } = await import('./server/repo/pool.js');"
            "let body; const res = { statusCode: 200, setHeader() {}, get headersSent() { return false; },"
            " status(c) { this.statusCode = c; return this; }, json(b) { body = b; }, end() {} };"
            "await handler({ method: 'GET', headers: {}, url: '/api/catalog' }, res);"
            "await closePool(); process.stdout.write(JSON.stringify(body));"
        )
        env = {**os.environ, "DATABASE_URL": self.url, "CLASSY_LOG": "off"}
        out = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=ROOT / "web",
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(out.stdout)["snapshotId"]

    def test_1_validate_passes(self):
        report = self.validate("snap-a")
        self.assertTrue(report.ok, report.render())

    def test_2_promote_rollback_and_forward(self):
        self.assertIsNone(self.pointer())
        gate.promote(self.conn, "snap-a", profile=PROFILE, object_root=self.objects)
        self.assertEqual(self.pointer(), "snap-a")
        gate.promote(self.conn, "snap-b", profile=PROFILE, object_root=self.objects)
        self.assertEqual(self.pointer(), "snap-b")
        self.assertEqual(self.catalog_snapshot(), "snap-b")

        before, after = gate.rollback(self.conn)
        self.assertEqual((before, after), ("snap-b", "snap-a"))
        self.assertEqual(self.pointer(), "snap-a")
        self.assertEqual(self.catalog_snapshot(), "snap-a")

        gate.promote(self.conn, "snap-b", profile=PROFILE, object_root=self.objects, reason="forward again")
        self.assertEqual(self.pointer(), "snap-b")
        self.assertEqual(
            self.history(),
            [
                (None, "snap-a", "promote"),
                ("snap-a", "snap-b", "promote"),
                ("snap-b", "snap-a", "rollback"),
                ("snap-a", "snap-b", "forward again"),
            ],
        )
        with self.assertRaises(gate.GateError):
            gate.promote(self.conn, "snap-b", profile=PROFILE, object_root=self.objects)

    def test_3_compare_and_swap(self):
        live = self.pointer()
        with self.assertRaises(gate.GateError):
            gate.move_pointer(self.conn, to_snapshot="snap-a", expected="someone-else", reason="race")
        self.assertEqual(self.pointer(), live)

    def test_4_rejects_bad_snapshots(self):
        cases = {
            "bad-blocked": dict(video="v019"),
            "bad-instagram": dict(video="A_V1"),
            "bad-norm": dict(vector="[2,0,0,0]"),
            "bad-timing": dict(timing=True),
            "bad-objects": dict(write_objects=False),
            "bad-sprite": dict(sprite=False),
        }
        for sid, kwargs in cases.items():
            self.add_snapshot(sid, **kwargs)
            with self.subTest(sid=sid):
                report = self.validate(sid)
                self.assertFalse(report.ok, sid)
        self.assertFalse(self.validate("snap-a", profile="other|p|4|document").ok)
        self.assertFalse(self.validate("missing").ok)
        with self.assertRaises(gate.GateError):
            gate.promote(self.conn, "bad-norm", profile=PROFILE, object_root=self.objects)

    def test_5_coverage_and_exact_only(self):
        self.add_snapshot("no-vectors", vector=None)
        self.assertFalse(self.validate("no-vectors").ok)
        self.assertTrue(self.validate("no-vectors", allow_exact_only=True).ok)

    def test_6_golden_queries_must_not_regress(self):
        live = self.pointer()
        other = "snap-a" if live == "snap-b" else "snap-b"
        live_table = {"all": {"recall@5": 0.8}, "query:en": {"recall@5": 1.0}, "query:ja": {"recall@5": 0.3}}
        worse_in_one_language = {"all": {"recall@5": 0.9}, "query:en": {"recall@5": 0.5}, "query:ja": {"recall@5": 1.0}}
        better_everywhere = {"all": {"recall@5": 0.9}, "query:en": {"recall@5": 1.0}, "query:ja": {"recall@5": 0.6}}

        report = self.validate(other, evaluate=lambda sid: live_table if sid == live else worse_in_one_language)
        self.assertFalse(report.ok)
        self.assertIn("query:en", report.render())
        report = self.validate(other, evaluate=lambda sid: live_table if sid == live else better_everywhere)
        self.assertTrue(report.ok, report.render())

        baseline = Path(tempfile.mkdtemp()) / "baseline.json"
        baseline.write_text(json.dumps({"recall@5": {"query:ja": 0.7}}))
        report = self.validate(
            other,
            evaluate=lambda sid: live_table if sid == live else better_everywhere,
            baseline_path=baseline,
        )
        self.assertFalse(report.ok)
        self.assertIn("baseline", report.render())

        def embedding_down(_sid):
            raise RuntimeError("65 of 65 queries fell back to exact matches")

        report = self.validate(other, evaluate=embedding_down)
        self.assertFalse(report.ok)
        self.assertIn("could not run", report.render())

    def test_7_prune_keeps_live_and_newest(self):
        doomed = gate.prune(self.conn, self.objects, keep=2, dry_run=True)
        self.assertNotIn(self.pointer(), doomed)


if __name__ == "__main__":
    unittest.main()
