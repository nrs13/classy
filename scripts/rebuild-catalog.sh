#!/bin/sh
# Rebuild a catalog database from the local snapshot.
# Set DATABASE_URL in the environment. This script never prints it.
# A Neon host is refused when NEON_BRANCH is missing or production,
# unless CLASSY_ALLOW_PRODUCTION=1.
# Pass --with-vectors to copy chunk embeddings. The default leaves them behind.
# Pass --vectors-only --snapshot <id> to copy one snapshot's embeddings and
# rebuild the vector index. That path does not truncate or reload other rows.

set -eu
cd "$(dirname "$0")/.."

with_vectors=0
vectors_only=0
snapshot_id=""
if [ "${1:-}" = "--with-vectors" ]; then
  with_vectors=1
elif [ "${1:-}" = "--vectors-only" ]; then
  vectors_only=1
  if [ "${2:-}" != "--snapshot" ] || [ -z "${3:-}" ]; then
    echo "usage: scripts/rebuild-catalog.sh --vectors-only --snapshot <id>" >&2
    exit 2
  fi
  snapshot_id="$3"
  case "$snapshot_id" in
    *[!A-Za-z0-9_-]*)
      echo "snapshot id must be letters, digits, hyphen, or underscore" >&2
      exit 2
      ;;
  esac
elif [ -n "${1:-}" ]; then
  echo "usage: scripts/rebuild-catalog.sh [--with-vectors | --vectors-only --snapshot <id>]" >&2
  exit 2
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Set DATABASE_URL in the environment. Do not put it in a tracked file." >&2
  exit 1
fi

python3 - <<'PY'
import os
import sys
from urllib.parse import urlparse

if os.environ.get("CLASSY_ALLOW_PRODUCTION") == "1":
    sys.exit(0)
url = os.environ.get("DATABASE_URL", "")
host = urlparse(url.replace("postgresql:", "http:", 1)).hostname or ""
branch = os.environ.get("NEON_BRANCH", "")
if host.endswith(".neon.tech") and branch in ("", "production"):
    sys.stderr.write(
        "Refusing the production database. Use the dev branch, "
        "or set CLASSY_ALLOW_PRODUCTION=1 for this command.\n"
    )
    sys.exit(1)
PY

source="${SOURCE_DATABASE_URL:-postgresql:///classy}"

if [ "$vectors_only" -eq 1 ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    DROP TABLE IF EXISTS chunk_vec_load;
    CREATE UNLOGGED TABLE chunk_vec_load (id bigint, embedding vector);"
  psql "$source" -v ON_ERROR_STOP=1 -c "COPY (
    SELECT id, embedding FROM chunk
    WHERE snapshot_id = '${snapshot_id}' AND embedding IS NOT NULL
  ) TO STDOUT" \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "COPY chunk_vec_load (id, embedding) FROM STDIN"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    UPDATE chunk AS c
    SET embedding = v.embedding
    FROM chunk_vec_load AS v
    WHERE c.id = v.id AND c.snapshot_id = '${snapshot_id}';
    DROP TABLE chunk_vec_load;
    REINDEX INDEX chunk_embedding_1024_first_hnsw;"
  psql "$DATABASE_URL" -c "
    SELECT count(*) AS vectors
    FROM chunk
    WHERE snapshot_id = '${snapshot_id}' AND embedding IS NOT NULL;"
  exit 0
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f catalog/schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
TRUNCATE pointer, pointer_history, clip, second, chunk, event, ingest,
         snapshot, query_understanding, embedding_cache
CASCADE;"

pg_dump "$source" \
  --data-only --no-owner --no-privileges \
  --table=public.snapshot \
  --table=public.pointer \
  --table=public.pointer_history \
  --table=public.clip \
  --table=public.second \
  --table=public.ingest \
  --table=public.event \
  --table=public.query_understanding \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1

if [ "$with_vectors" -eq 1 ]; then
  pg_dump "$source" \
    --data-only --no-owner --no-privileges \
    --table=public.chunk \
    --table=public.embedding_cache \
    | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
else
  psql "$source" -v ON_ERROR_STOP=1 -c "COPY (
    SELECT id, video_id, snapshot_id, t_sec, field, text, model, dimension,
           confidence, end_sec, speaker, language, context, is_repeat
    FROM chunk
  ) TO STDOUT" \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "COPY chunk (
    id, video_id, snapshot_id, t_sec, field, text, model, dimension,
    confidence, end_sec, speaker, language, context, is_repeat
  ) FROM STDIN"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "SELECT setval('chunk_id_seq', COALESCE((SELECT max(id) FROM chunk), 1));"
fi

psql "$DATABASE_URL" -c "SELECT snapshot_id FROM pointer;" \
  -c "SELECT count(*) AS clips FROM clip WHERE snapshot_id = (SELECT snapshot_id FROM pointer);"
