import json
import math
import sys
import unittest
import urllib.error
from email.message import Message
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CATALOG))

from providers import embedding  # noqa: E402
from providers.embedding import (  # noqa: E402
    EmbeddingError,
    GeminiDocuments,
    VoyageDocuments,
    format_document,
    format_query,
)

FIXTURE = json.loads((CATALOG / "providers" / "format_fixture.json").read_text())


def unit(dim, hot=0):
    vec = [0.0] * dim
    vec[hot % dim] = 1.0
    return vec


class FormatFixture(unittest.TestCase):
    def test_limits_match_fixture(self):
        self.assertEqual(embedding.MAX_DOCUMENT_CHARS, FIXTURE["maxDocumentChars"])
        self.assertEqual(embedding.MAX_QUERY_CHARS, FIXTURE["maxQueryChars"])

    def test_cases(self):
        for case in FIXTURE["cases"]:
            with self.subTest(case=case["input"]):
                self.assertEqual(format_document(case["input"]), case["expected"])
                self.assertEqual(format_query(case["input"]), case["expected"])

    def test_code_point_limit(self):
        self.assertEqual(len(format_document("🧠" * (embedding.MAX_DOCUMENT_CHARS + 10))), embedding.MAX_DOCUMENT_CHARS)

    def test_profiles_match_js(self):
        self.assertEqual(VoyageDocuments({}).profile, FIXTURE["profiles"]["voyage"])
        self.assertEqual(GeminiDocuments({}).profile, FIXTURE["profiles"]["gemini"])
        lite = VoyageDocuments({"CLASSY_EMBED_DOC_MODEL": "voyage-4-lite"})
        self.assertEqual(lite.profile, FIXTURE["profiles"]["voyage"])


class VoyageDocumentsTest(unittest.TestCase):
    def test_batches_formats_and_orders(self):
        calls = []

        def post(url, body, headers, timeout, attempts, sleep):
            calls.append(body)
            n = len(body["input"])
            data = [{"index": i, "embedding": unit(1024, i)} for i in reversed(range(n))]
            return {"data": data}

        provider = VoyageDocuments({"VOYAGE_API_KEY": "k"}, post=post)
        texts = [f"  text {i}\n" for i in range(130)]
        vectors = provider.embed_documents(texts)
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(calls[0]["input"]), 128)
        self.assertEqual(calls[0]["input"][0], "text 0")
        self.assertEqual(calls[0]["input_type"], "document")
        self.assertEqual(calls[0]["model"], "voyage-4-large")
        self.assertEqual(calls[0]["output_dimension"], 1024)
        self.assertEqual(vectors[3].index(1.0), 3)

    def test_rejects_wrong_dimension(self):
        provider = VoyageDocuments(
            {"VOYAGE_API_KEY": "k"}, post=lambda *a: {"data": [{"index": 0, "embedding": [1.0] * 10}]}
        )
        with self.assertRaises(ValueError):
            provider.embed_documents(["x"])

    def test_normalizes(self):
        provider = VoyageDocuments(
            {"VOYAGE_API_KEY": "k"}, post=lambda *a: {"data": [{"index": 0, "embedding": [3.0] + [0.0] * 1023}]}
        )
        [vec] = provider.embed_documents(["x"])
        self.assertAlmostEqual(math.sqrt(sum(v * v for v in vec)), 1.0)

    def test_without_key(self):
        with self.assertRaises(EmbeddingError):
            VoyageDocuments({}).embed_documents(["x"])


class RetryTest(unittest.TestCase):
    def test_retries_429_then_succeeds(self):
        attempts = []
        waits = []

        def fake_urlopen(request, timeout, context):
            attempts.append(1)
            if len(attempts) < 3:
                headers = Message()
                headers["Retry-After"] = "1"
                raise urllib.error.HTTPError(request.full_url, 429, "slow down", headers, None)

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return False

                def read(self):
                    return json.dumps({"ok": True}).encode()

            return Response()

        original = embedding.urllib.request.urlopen
        embedding.urllib.request.urlopen = fake_urlopen
        try:
            out = embedding._post_json("https://x", {}, {}, 1, 5, waits.append)
        finally:
            embedding.urllib.request.urlopen = original
        self.assertEqual(out, {"ok": True})
        self.assertEqual(len(attempts), 3)
        self.assertEqual(waits, [1.0, 1.0])

    def test_does_not_retry_400(self):
        attempts = []

        def fake_urlopen(request, timeout, context):
            attempts.append(1)
            raise urllib.error.HTTPError(request.full_url, 400, "bad", Message(), None)

        original = embedding.urllib.request.urlopen
        embedding.urllib.request.urlopen = fake_urlopen
        try:
            with self.assertRaises(EmbeddingError):
                embedding._post_json("https://x", {}, {}, 1, 5, lambda s: None)
        finally:
            embedding.urllib.request.urlopen = original
        self.assertEqual(len(attempts), 1)


if __name__ == "__main__":
    unittest.main()
