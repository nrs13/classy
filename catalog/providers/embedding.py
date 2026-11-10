"""Document embeddings for the packer.

Mirror of web/server/providers/embedding: same profile string, same text rules
(format_fixture.json pins both), documents only. Providers never touch the database;
embed_with_cache does, through the connection it is given.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import ssl
import time
import unicodedata
import urllib.error
import urllib.request
from typing import Callable, Iterable

MAX_DOCUMENT_CHARS = 4000
MAX_QUERY_CHARS = 1000
BATCH = 128
NORM_TOLERANCE = 1e-3

_ZERO_WIDTH = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")
_SPACE = re.compile("[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+")


def _clean(text, limit: int) -> str:
    flat = unicodedata.normalize("NFC", "" if text is None else str(text))
    flat = _SPACE.sub(" ", _ZERO_WIDTH.sub("", flat)).strip()
    return flat[:limit].rstrip() if len(flat) > limit else flat


def format_document(text) -> str:
    return _clean(text, MAX_DOCUMENT_CHARS)


def format_query(text) -> str:
    return _clean(text, MAX_QUERY_CHARS)


def text_hash(formatted: str) -> str:
    return hashlib.sha256(formatted.encode("utf-8")).hexdigest()


def voyage_series(model: str) -> str:
    match = re.match(r"^voyage-(\d+(?:\.\d+)?)", model or "")
    return f"{match.group(1)}-series" if match else model


def check_unit(vector: list[float], dim: int) -> list[float]:
    if len(vector) != dim:
        raise ValueError(f"embedding_dimension_mismatch:{len(vector)}")
    norm = math.sqrt(sum(v * v for v in vector))
    if abs(norm - 1) > NORM_TOLERANCE:
        raise ValueError(f"embedding_not_normalized:{norm:.5f}")
    return vector


def l2normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm else vector


def _ssl_context():
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


class EmbeddingError(RuntimeError):
    pass


def _post_json(url: str, body: dict, headers: dict, timeout: float, attempts: int, sleep: Callable[[float], None]):
    data = json.dumps(body).encode()
    context = _ssl_context()
    delay = 2.0
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as err:
            retryable = err.code == 429 or err.code >= 500
            if not retryable or attempt == attempts:
                raise EmbeddingError(f"embedding_http_{err.code}") from None
            wait = float(err.headers.get("Retry-After") or delay)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            if attempt == attempts:
                raise EmbeddingError(f"embedding_unreachable: {getattr(err, 'reason', err)}") from None
            wait = delay
        sleep(min(wait, 60.0))
        delay *= 2
    raise EmbeddingError("embedding_failed")


class VoyageDocuments:
    name = "voyage"
    endpoint = "https://api.voyageai.com/v1/embeddings"

    def __init__(self, env=None, *, post=None, sleep=time.sleep, attempts: int = 6):
        env = os.environ if env is None else env
        self.key = env.get("VOYAGE_API_KEY", "")
        self.dim = int(env.get("CLASSY_EMBED_DIM") or 1024)
        self.model = env.get("CLASSY_EMBED_DOC_MODEL") or "voyage-4-large"
        self.profile = f"voyage|{voyage_series(self.model)}|{self.dim}|document"
        self._post = post or _post_json
        self._sleep = sleep
        self._attempts = attempts

    @property
    def configured(self) -> bool:
        return bool(self.key)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not self.key:
            raise EmbeddingError("embedding_not_configured")
        out: list[list[float]] = []
        for start in range(0, len(texts), BATCH):
            batch = [format_document(t) for t in texts[start : start + BATCH]]
            payload = self._post(
                self.endpoint,
                {"input": batch, "model": self.model, "input_type": "document", "output_dimension": self.dim},
                {"Authorization": f"Bearer {self.key}"},
                120,
                self._attempts,
                self._sleep,
            )
            rows = sorted(payload.get("data") or [], key=lambda row: row["index"])
            if len(rows) != len(batch):
                raise EmbeddingError("embedding_count_mismatch")
            out.extend(check_unit(l2normalize(row["embedding"]), self.dim) for row in rows)
        return out


class GeminiDocuments:
    name = "gemini"

    def __init__(self, env=None, *, post=None, sleep=time.sleep, attempts: int = 6):
        env = os.environ if env is None else env
        self.key = env.get("GEMINI_API_KEY") or env.get("GOOGLE_API_KEY") or ""
        self.dim = int(env.get("CLASSY_EMBED_DIM") or 768)
        self.model = env.get("CLASSY_EMBED_DOC_MODEL") or "gemini-embedding-001"
        self.profile = f"gemini|{self.model}|{self.dim}|retrieval"
        self._post = post or _post_json
        self._sleep = sleep
        self._attempts = attempts

    @property
    def configured(self) -> bool:
        return bool(self.key)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not self.key:
            raise EmbeddingError("embedding_not_configured")
        out: list[list[float]] = []
        for start in range(0, len(texts), 64):
            batch = [format_document(t) for t in texts[start : start + 64]]
            payload = self._post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:batchEmbedContents",
                {
                    "requests": [
                        {
                            "model": f"models/{self.model}",
                            "content": {"parts": [{"text": text}]},
                            "taskType": "RETRIEVAL_DOCUMENT",
                            "outputDimensionality": self.dim,
                        }
                        for text in batch
                    ]
                },
                {"x-goog-api-key": self.key},
                120,
                self._attempts,
                self._sleep,
            )
            rows = payload.get("embeddings") or []
            if len(rows) != len(batch):
                raise EmbeddingError("embedding_count_mismatch")
            out.extend(check_unit(l2normalize(row.get("values") or []), self.dim) for row in rows)
        return out


def get_document_provider(env=None):
    env = os.environ if env is None else env
    if (env.get("CLASSY_EMBED_PROVIDER") or "voyage").lower() == "gemini":
        return GeminiDocuments(env)
    return VoyageDocuments(env)


def vector_literal(vector: Iterable[float]) -> str:
    return "[" + ",".join(f"{v:.8f}" for v in vector) + "]"


def embed_with_cache(conn, provider, texts: Iterable[str], *, chunk: int = 512, log=print) -> dict[str, str]:
    """Return {formatted text: vector literal} for every distinct non-empty text.

    Cached vectors are reused. New vectors are written to embedding_cache and committed after
    every chunk, so a failure partway keeps what was already paid for.
    """
    formatted = sorted({format_document(t) for t in texts} - {""})
    hashes = {text: text_hash(text) for text in formatted}
    found: dict[str, str] = {}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT text_hash, vector::text FROM embedding_cache WHERE profile = %s AND text_hash = ANY(%s)",
            (provider.profile, list(hashes.values())),
        )
        by_hash = dict(cur.fetchall())
    missing = []
    for text in formatted:
        cached = by_hash.get(hashes[text])
        if cached:
            found[text] = cached
        else:
            missing.append(text)
    log(f"embedding {len(formatted)} distinct texts: {len(found)} cached, {len(missing)} new ({provider.profile})")
    for start in range(0, len(missing), chunk):
        part = missing[start : start + chunk]
        vectors = provider.embed_documents(part)
        rows = [(provider.profile, hashes[text], vector_literal(vec)) for text, vec in zip(part, vectors)]
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO embedding_cache (profile, text_hash, vector) VALUES (%s, %s, %s::vector) "
                "ON CONFLICT (profile, text_hash) DO NOTHING",
                rows,
            )
        conn.commit()
        for (_profile, _hash, literal), text in zip(rows, part):
            found[text] = literal
        log(f"  embedded {min(start + chunk, len(missing))}/{len(missing)}")
    return found
