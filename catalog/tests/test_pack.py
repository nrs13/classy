"""Packer pieces: segments, scores, timing rule, and embedding cache reuse."""

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

CATALOG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CATALOG))

import pack_snapshot  # noqa: E402
from providers import embedding  # noqa: E402
from segments import (  # noqa: E402
    SEGMENT_MAX,
    build_segments,
    chunks_for,
    context_around,
    merge_overlap,
)

try:
    import psycopg2
except ImportError:  # pragma: no cover
    psycopg2 = None


def second(t, speech="", speaker="", screen=None):
    return {"t_sec": t, "speech": speech, "speaker": speaker, "text_on_screen": screen or []}


class SegmentTest(unittest.TestCase):
    def test_merge_overlap_drops_repeated_words(self):
        self.assertEqual(merge_overlap("we went to the", "to the beach today"), "beach today")
        self.assertEqual(merge_overlap("hello there", "something else"), "something else")
        self.assertEqual(merge_overlap("same line", "same line"), "")

    def test_context_around_skips_the_current_line_and_respects_radius(self):
        track = [(0, "first"), (2, "current"), (3, "current"), (5, "next"), (20, "far")]
        self.assertEqual(context_around(track, 2, 3, "current"), {"before": "first", "after": "next"})
        self.assertIsNone(context_around(track, 40, 40, "x"))
        self.assertEqual(context_around(track, 11, 11, "x"), {"before": "next", "after": ""})
        self.assertEqual(context_around(track, 15, 15, "x"), {"before": "", "after": "far"})

    def test_segments_cut_on_new_line_after_minimum_and_on_gaps(self):
        rows = [second(t, "line one", "A") for t in range(0, 7)]
        rows += [second(7, "line two", "A")]
        rows += [second(t, "line two", "A") for t in range(8, 10)]
        rows += [second(20, "after a gap", "B")]
        segments = build_segments(rows)
        self.assertEqual([(s.t_sec, s.end_sec) for s in segments], [(0, 7), (7, 10), (20, 21)])
        self.assertTrue(all(s.field == "segment" for s in segments))
        self.assertEqual(segments[0].text, "line one")
        self.assertEqual(segments[0].speaker, "A")
        self.assertEqual(segments[0].context, {"before": "", "after": "line two"})

    def test_segments_never_exceed_the_maximum(self):
        rows = [second(t, f"word{t}") for t in range(0, 40)]
        for segment in build_segments(rows):
            self.assertLessEqual(segment.end_sec - segment.t_sec, SEGMENT_MAX + 1)

    def test_segments_merge_overlapping_transcript_and_screen_text(self):
        rows = [
            second(0, "so today we", screen=[{"text": "EXAM DAY"}]),
            second(1, "so today we have the exam", screen=[{"text": "EXAM DAY"}]),
            second(2, "the exam in maths"),
        ]
        (segment,) = build_segments(rows)
        self.assertEqual(segment.text, "so today we have the exam in maths / EXAM DAY")

    def test_speaker_only_when_the_window_has_one(self):
        rows = [second(0, "hi", "A"), second(1, "hello", "B")]
        (segment,) = build_segments(rows)
        self.assertEqual(segment.speaker, "")

    def test_chunks_for_keeps_fields_and_normalizes_scores(self):
        rows = [
            {
                "t_sec": 3,
                "speech": "Ciao a tutti",
                "speech_score": 92,
                "speaker": "Speaker #1",
                "text_on_screen": [{"text": "FINALS", "score": 0.7}],
                "scenes": [{"sentence": "A desk", "evidence": "books"}],
                "ask": {"phrase_original": "seguimi", "phrase_en": "follow me"},
            }
        ]
        chunks = chunks_for(rows, {"topic": ["School"], "keyword": []}, "Visual", pack_snapshot.normalize_score)
        by_field = {c.field: c for c in chunks}
        self.assertEqual(by_field["speech"].confidence, 0.92)
        self.assertEqual(by_field["speech"].speaker, "Speaker #1")
        self.assertEqual(by_field["text_on_screen"].confidence, 0.7)
        self.assertEqual(by_field["ask"].text, "seguimi follow me")
        self.assertEqual(by_field["topic"].text, "School")
        self.assertNotIn("keyword", by_field)
        self.assertEqual(by_field["activation"].text, "Visual")
        self.assertIn("segment", by_field)


class PackRulesTest(unittest.TestCase):
    def test_ids(self):
        self.assertTrue(pack_snapshot.include_id("v002"))
        self.assertFalse(pack_snapshot.include_id("A_V1"))
        self.assertFalse(pack_snapshot.include_id(""))
        for blocked in ("v019", "v035", "v036", "v054", "v080", "v084", "v090"):
            self.assertFalse(pack_snapshot.include_id(blocked), blocked)

    def test_normalize_score(self):
        self.assertEqual(pack_snapshot.normalize_score(80), 0.8)
        self.assertEqual(pack_snapshot.normalize_score(0.4), 0.4)
        self.assertEqual(pack_snapshot.normalize_score("0.5"), 0.5)
        self.assertIsNone(pack_snapshot.normalize_score(None))
        self.assertIsNone(pack_snapshot.normalize_score(-0.1))
        self.assertIsNone(pack_snapshot.normalize_score(250))

    def test_timing_set_needs_save_model_and_enough_overlap(self):
        seconds8 = set(range(pack_snapshot.MIN_TIMING_SECONDS))
        dataset = {"v002": {"save_model": "1"}, "v006": {"save_model": "0"}, "v008": {"save_model": "1"}}
        picked = pack_snapshot.timing_set(
            dataset,
            {"v002": seconds8, "v006": seconds8, "v008": set(range(pack_snapshot.MIN_TIMING_SECONDS - 1))},
            {"v002": seconds8, "v006": seconds8, "v008": seconds8},
        )
        self.assertEqual(picked, ["v002"])
        self.assertEqual(pack_snapshot.timing_set(dataset, {"v002": seconds8}, {}), [])

    def test_timing_sentences_only_at_exactly_78(self):
        self.assertEqual(pack_snapshot.EXPECTED_TIMING, 78)
        self.assertEqual(pack_snapshot.gate.EXPECTED_TIMING, 78)


class FakeProvider:
    profile = "test|fake|4|document"

    def __init__(self):
        self.calls = []

    def embed_documents(self, texts):
        self.calls.append(list(texts))
        return [embedding.l2normalize([1.0, float(len(t)), 0.0, 0.0]) for t in texts]


@unittest.skipIf(psycopg2 is None, "psycopg2 not installed")
class EmbeddingCacheTest(unittest.TestCase):
    DB = f"classy_pack_test_{os.getpid()}"

    @classmethod
    def setUpClass(cls):
        try:
            admin = psycopg2.connect("postgresql:///postgres")
        except psycopg2.OperationalError as err:  # pragma: no cover
            raise unittest.SkipTest(f"Postgres not available: {err}")
        admin.autocommit = True
        with admin.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS {cls.DB}")
            cur.execute(f"CREATE DATABASE {cls.DB}")
        admin.close()
        cls.conn = psycopg2.connect(f"postgresql:///{cls.DB}")
        with cls.conn.cursor() as cur:
            cur.execute((CATALOG / "schema.sql").read_text())
        cls.conn.commit()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        admin = psycopg2.connect("postgresql:///postgres")
        admin.autocommit = True
        with admin.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS {cls.DB} WITH (FORCE)")
        admin.close()

    def test_second_run_reuses_the_cache(self):
        provider = FakeProvider()
        texts = ["Hola  a todos", "Hola a todos", "SchoolGPT", "", "e\u0301xam"]
        first = embedding.embed_with_cache(self.conn, provider, texts, chunk=2, log=lambda _m: None)
        self.assertEqual(sorted(first), sorted({"Hola a todos", "SchoolGPT", "\u00e9xam"}))
        self.assertEqual(sum(len(c) for c in provider.calls), 3)
        self.assertEqual(len(provider.calls), 2)

        again = FakeProvider()
        second_run = embedding.embed_with_cache(self.conn, again, texts + ["new line"], log=lambda _m: None)
        self.assertEqual(again.calls, [["new line"]])
        for text, literal in first.items():
            self.assertEqual(
                [round(float(v), 6) for v in second_run[text].strip("[]").split(",")],
                [round(float(v), 6) for v in literal.strip("[]").split(",")],
            )
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM embedding_cache WHERE profile = %s AND text_hash = ANY(%s)",
                (provider.profile, [embedding.text_hash(t) for t in [*first, "new line"]]),
            )
            self.assertEqual(cur.fetchone()[0], 4)

    def test_profiles_do_not_share_vectors(self):
        provider = FakeProvider()
        embedding.embed_with_cache(self.conn, provider, ["shared text"], log=lambda _m: None)
        other = FakeProvider()
        other.profile = "test|other|4|document"
        embedding.embed_with_cache(self.conn, other, ["shared text"], log=lambda _m: None)
        self.assertEqual(other.calls, [["shared text"]])


class DeriveProvider(FakeProvider):
    profile = "test|fake|4|document"
    model = "fake"
    dim = 4
    configured = True


class AddSource:
    """Stands in for LabFilesSource; pack_video is patched, so only ready() and public() are read."""

    def __init__(self, ready):
        self._ready = ready

    def ready(self):
        return list(self._ready)

    def public(self, _video_id):
        return {}


@unittest.skipIf(psycopg2 is None, "psycopg2 not installed")
class DeriveTest(unittest.TestCase):
    """--derive: kept videos are copied with their vectors and objects; only added videos cost work."""

    DB = f"classy_derive_test_{os.getpid()}"
    BASE = "ku-base"

    @classmethod
    def setUpClass(cls):
        try:
            admin = psycopg2.connect("postgresql:///postgres")
        except psycopg2.OperationalError as err:  # pragma: no cover
            raise unittest.SkipTest(f"Postgres not available: {err}")
        admin.autocommit = True
        with admin.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS {cls.DB}")
            cur.execute(f"CREATE DATABASE {cls.DB}")
        admin.close()
        cls.objects = Path(tempfile.mkdtemp())
        cls.env = mock.patch.dict(os.environ, {"CLASSY_OBJECT_ROOT": str(cls.objects), "CLASSY_BUCKET": ""})
        cls.env.start()
        cls.conn = psycopg2.connect(f"postgresql:///{cls.DB}")
        pack_snapshot.apply_schema(cls.conn)
        with cls.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO snapshot (id, complete, embedding_model, embedding_dim, embedding_profile) "
                "VALUES (%s, true, 'fake', 4, %s)",
                (cls.BASE, DeriveProvider.profile),
            )
            for video_id in ("v001", "v002"):
                cls.insert_video(cur, cls.BASE, video_id, vector="[1,0,0,0]")
            pack_snapshot.mark_repeats(cur, cls.BASE)
        cls.conn.commit()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        cls.env.stop()
        shutil.rmtree(cls.objects, ignore_errors=True)
        admin = psycopg2.connect("postgresql:///postgres")
        admin.autocommit = True
        with admin.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS {cls.DB} WITH (FORCE)")
        admin.close()

    @classmethod
    def insert_video(cls, cur, snapshot_id, video_id, vector=None):
        keys = {}
        for column, suffix in (("mp4_object", "mp4"), ("act_object", "bin"), ("sprite_object", "frames.jpg")):
            keys[column] = f"snapshots/{snapshot_id}/{video_id}.{suffix}"
            path = cls.objects / keys[column]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"{video_id}-{suffix}".encode())
        cur.execute(
            "INSERT INTO clip (video_id, snapshot_id, language, account, curve, timing_candidate, "
            "mp4_object, act_object, sprite_object, sprite_meta) "
            "VALUES (%s, %s, 'en-US', 'acct', '[0.1]', true, %s, %s, %s, '{\"cols\":1,\"rows\":1,\"count\":1,\"interval\":1}')",
            (video_id, snapshot_id, keys["mp4_object"], keys["act_object"], keys["sprite_object"]),
        )
        for t_sec, text in ((0, f"{video_id} desk scene"), (1, f"{video_id} desk scene"), (2, f"{video_id} other")):
            cur.execute(
                "INSERT INTO chunk (video_id, snapshot_id, t_sec, field, text, embedding, model, dimension) "
                "VALUES (%s, %s, %s, 'scene', %s, %s::vector, %s, %s)",
                (video_id, snapshot_id, t_sec, text, vector, "fake" if vector else None, 4 if vector else None),
            )

    def fake_pack_video(self, cur, snapshot_id, _store, video_id, _source):
        self.insert_video(cur, snapshot_id, video_id)

    def rows(self, sql, params):
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            out = cur.fetchall()
        self.conn.commit()
        return out

    def test_drop_then_add(self):
        provider = DeriveProvider()
        dropped = pack_snapshot.derive(self.conn, self.BASE, AddSource([]), provider, drop=["v002"])
        self.assertEqual(provider.calls, [])
        self.assertEqual(self.rows("SELECT video_id FROM clip WHERE snapshot_id = %s", (dropped,)), [("v001",)])
        (keys,) = self.rows("SELECT mp4_object, act_object, sprite_object FROM clip WHERE snapshot_id = %s", (dropped,))
        for key, old in zip(keys, (f"snapshots/{self.BASE}/v001.mp4", f"snapshots/{self.BASE}/v001.bin",
                                   f"snapshots/{self.BASE}/v001.frames.jpg")):
            self.assertEqual(key, old.replace(self.BASE, dropped))
            self.assertEqual((self.objects / key).stat().st_ino, (self.objects / old).stat().st_ino)
        self.assertEqual(
            self.rows(
                "SELECT t_sec, is_repeat, embedding IS NOT NULL FROM chunk WHERE snapshot_id = %s ORDER BY t_sec",
                (dropped,),
            ),
            [(0, False, True), (1, True, True), (2, False, True)],
        )
        self.assertEqual(
            self.rows("SELECT complete, embedding_profile FROM snapshot WHERE id = %s", (dropped,)),
            [(True, DeriveProvider.profile)],
        )

        with mock.patch.object(pack_snapshot, "pack_video", self.fake_pack_video):
            added = pack_snapshot.derive(self.conn, dropped, AddSource(["v003"]), provider, add=["v003"])
        self.assertEqual(sorted(sum(provider.calls, [])), ["v003 desk scene", "v003 other"])
        self.assertEqual(
            self.rows(
                "SELECT video_id, t_sec, is_repeat, embedding IS NOT NULL FROM chunk WHERE snapshot_id = %s "
                "ORDER BY video_id, t_sec",
                (added,),
            ),
            [
                ("v001", 0, False, True), ("v001", 1, True, True), ("v001", 2, False, True),
                ("v003", 0, False, True), ("v003", 1, True, True), ("v003", 2, False, True),
            ],
        )
        self.assertEqual(
            self.rows("SELECT count(*) FILTER (WHERE timing_eligible) FROM clip WHERE snapshot_id = %s", (added,)),
            [(0,)],
        )
        self.assertEqual(self.rows("SELECT count(*) FROM clip WHERE snapshot_id = %s", (self.BASE,)), [(2,)])

    def test_rejects_excluded_and_unready_ids(self):
        for add in (["v019"], ["A_V1"]):
            with self.assertRaises(SystemExit):
                pack_snapshot.derive(self.conn, self.BASE, AddSource(add), DeriveProvider(), add=add)
        with self.assertRaises(SystemExit):
            pack_snapshot.derive(self.conn, self.BASE, AddSource([]), DeriveProvider(), add=["v009"])
        with self.assertRaises(SystemExit):
            pack_snapshot.derive(self.conn, "missing", AddSource([]), DeriveProvider(), drop=["v001"])


if __name__ == "__main__":
    unittest.main()
