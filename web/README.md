# Classy web

Frontend lives here. Full setup is in the root [README](../README.md).

```bash
npm install
npm run dev          # brain + Library (serves web/api through vite-plugin-chat.js)
vercel dev           # same routes as Vercel functions
npm test             # node --test (unit + API routes against a throwaway Postgres)
npm run lint
```

`npm run dev` loads modules in `server/` once. Restart it after editing anything under `server/` or `api/`.

## Search architecture

The Library is one complete Postgres snapshot that the `pointer` row names. Every route reads only that snapshot.

```
api/*.js            thin routes: method check, rate limit, requestId, safe JSON errors
server/search/      query.js parse  ->  understand.js meaning  ->  retrieve.js lanes
                    ->  rank.js RRF + grouping  ->  explain.js quotes and labels  ->  frames.js
server/repo/        SQL only (chunks, videos, snapshot, ingest)
server/providers/   embedding (voyage, gemini) and rerank; never touch the database
server/obs/         JSON logs, Server-Timing, error mapping
src/lib/useLibrarySearch.js   client timing, cache and stale-state rules (rail and Search page share it)
```

### Understanding (any language)

A query that a model can improve is sent to Claude (`CLASSY_UNDERSTAND_MODEL`, default `claude-haiku-4-5`) through one forced tool call that returns strict JSON: an English search phrase, the query's language, any language the user asks the video to be in, and a kind (said, on screen, scene). Quoted text, one-word ASCII queries and plain English without a language or kind hint are not sent.

- Answers come from memory, then the `query_understanding` table, then the model.
- Search waits at most 1200 ms. A slower answer is not waited for but still lands in both caches, and the response says `understanding: "pending"`; the client asks once more after 1.5 s and swaps in the better results.
- Calls count against the local spend cap (`CLASSY_MAX_SPEND_USD`). A failure, timeout or missing key means search runs on the typed text alone.
- Understanding never filters. A requested language adds a bonus of one rank-1 lane (`1/61`), which breaks ties but cannot overtake a clearly better match.

### Lanes

A search runs these lanes against the live snapshot:

- **Keyword**: a whole-query substring lane (trigram index), a strict `websearch_to_tsquery('simple')` lane, and a relaxed OR lane ranked by how many query words a line covers (used only when strict finds fewer than 5).
- **Keyword ranking**: lines containing the whole query as words come first. Lines containing it only inside a longer word ("exam" in "examples") rank after lines with every term.
- **Vector**: pgvector cosine over chunk embeddings through the partial HNSW index `chunk_embedding_1024_first_hnsw`, with iterative scan so the snapshot filter still returns enough rows. It runs only when the snapshot's `embedding_profile` equals the provider profile (`voyage|4-series|1024|document`). Otherwise, or when the query embedding fails (timeout, rate limit), the response carries the notice "Showing exact matches only right now."
- **English rewrite**: when understanding rewrote the query, `keyword_en` and `vector_en` run the English phrase. Each pairs with its original lane as one family: the better rank counts, never both.
- **Whole video** (`video`, `video_en`): one chunk per video summarising it. Packed, but off by default (`videoDocs: false`); on the golden set it changed one query out of 107.

Repeated lines (the same text in the same field of a video at a later second) carry `is_repeat`. They keep their vectors but are left out of the HNSW index, so they cannot crowd out distinct lines. Hidden fields are filtered in SQL before the limit.

### Results

Lanes merge with reciprocal rank fusion (k = 60). Results are grouped by video, each with a best moment and up to two more. Each moment has a quote, the line before and after, a speaker only when the video has more than one, a kind (said, on screen, scene), a frame from the video's sprite, and a match label: exact words, words match or similar meaning. Highlights mark only literal matches (the phrase, or whole content words of four or more letters, two for Chinese, Japanese and Korean); a meaning-only match marks nothing. Labels and strength describe retrieval only; they say nothing about the brain response or performance.

Network labels (activation), topics and keywords are packed but never searched.

### Client timing and states

- The exact pass runs 120 ms after typing stops; the full pass 450 ms after, or at once on Enter.
- Results are cached per snapshot, query and filters. A pending understanding is not cached.
- State carries the key it belongs to, so a new query never shows the previous query's empty or error state; it shows the older results dimmed until the new ones land.
- A query wrapped entirely in quotes is keyword only.
- Query vectors are cached in memory (LRU, 500) and in `embedding_cache`. Document vectors are cached in `embedding_cache` by profile and text hash, so repacking only pays for new text.
- Queries are capped at 300 characters. Search is limited to 60 requests per 10 seconds per client.
- Rerank is off unless `CLASSY_RERANK=gemini`.

### Debugging a search

```bash
node scripts/search-debug.mjs "chica bailando en el pasillo" [--expect v027] [--lang es] [--kind scene] [--mode exact]
```

It prints the understanding, every lane with rank, score and text, the fused groups and stage timings, and says where the expected video landed.

## Snapshots

```bash
python3 catalog/pack_snapshot.py                  # pack a new snapshot; never goes live
python3 catalog/pack_snapshot.py --validate ID    # coverage, vectors, profile, curves, 78 rule, objects, golden queries
python3 catalog/pack_snapshot.py --promote ID     # validate, then compare-and-swap the pointer (with history)
python3 catalog/pack_snapshot.py --rollback       # back to the previously live snapshot
python3 catalog/pack_snapshot.py --derive BASE --add v101 --drop v007 [--live]   # incremental snapshot
python3 catalog/eval/run.py --snapshot ID --save --failures   # recall@5, top1 and MRR per language and kind
python3 catalog/eval/run.py --set-baseline        # record the live numbers as the promote gate
python3 -m unittest catalog.tests.test_pack catalog.tests.test_frames catalog.tests.test_gate catalog.tests.test_embedding
```

Before a promote, golden queries must not drop below `catalog/eval/baseline.json`: recall@5 per query language, and the first-place rate overall. If query embedding fails during an evaluation, it stops instead of reporting exact-only numbers as hybrid, and `--validate` fails. `--options '{"videoDocs": true}'` runs an A/B against the same snapshot.

On the 107-query set (8 query languages; quoted, verbatim, paraphrase, name, scene, on-screen, describe and intent queries), the live snapshot scores recall@5 1.0 in every language and top1 0.916. The latency budgets in the baseline are 150 ms for exact and cached searches, 1500 ms for a new hybrid search, and 2200 ms when understanding runs.

A pack that stops after writing chunks (for example during embedding) leaves an incomplete snapshot that is never served. `pack_snapshot.py --finish ID` embeds it from `embedding_cache` and marks it complete.

### Frames

The pack extracts one frame per second into a JPEG sprite per video (`catalog/frames.py`, ffmpeg) and records `sprite_object` and `sprite_meta` (columns, rows, count, interval, cell size) on the clip. `--validate` rejects a snapshot whose sprites are missing or do not match their metadata. `/api/media?kind=sprite` redirects to a signed URL; the client shows the cell nearest each moment.

### Ingest

Each video moves through one state machine, recorded in `ingest`:

```
queued -> fetching -> tribe -> indexing -> packing -> validating -> live
                                                       (any step) -> failed | blocked
```

Fetching, TRIBE, Video Indexer and Content Understanding belong to the ingest worker. `pack_snapshot.py` owns packing, validating and live: `build_video` reads one video's lab files into rows, `write_video` writes them, and `--derive` builds a new snapshot from the live one with only the added videos packed and embedded (the rest are copied, objects hardlinked). The 78-row timing rule and the exclusion list (Instagram and blocked ids) apply on every path. A derived snapshot goes live only through the same validate and promote gate.

## Deployment environment

Set these on the host. The example file keeps every value empty. Do not put a key in a URL or in the client bundle. `GEMINI_CHAT_API_KEY` is read only on the server and is separate from `GEMINI_API_KEY`.

```
CHAT_MODE=
CHAT_PROVIDER=
CHAT_MODEL=
GEMINI_CHAT_API_KEY=
CLASSY_CHAT_DAILY_CAP=
DATABASE_URL=
CLASSY_BUCKET=
CLASSY_R2_ACCOUNT_ID=
CLASSY_R2_ACCESS_KEY_ID=
CLASSY_R2_SECRET_ACCESS_KEY=
CLASSY_OBJECT_ROOT=
CLASSY_MEDIA_SECRET=
```

- `CHAT_MODE`: `off`, `canned`, or `live`. A missing or any other value is `off`, which does not call a model.
- `CHAT_PROVIDER`: `gemini` or `anthropic`. Empty uses Gemini. `mock` simulates chat failures for local development only.
- `CHAT_MODEL`: empty uses `gemini-3.5-flash-lite`. The chat route sets `maxDuration` to 60 seconds. On the Hobby plan the platform ceiling is 300 seconds.
- `GEMINI_CHAT_API_KEY`: required for live Gemini. Leave empty to keep live mode unavailable.
- `CLASSY_CHAT_DAILY_CAP`: empty uses 400 live requests per Pacific day, under the reported free daily limit for `gemini-3.5-flash-lite`.

`CHAT_PROVIDER=mock` answers from this process instead of Gemini. Pick a fault with the `x-classy-chat-fault` header or the `chatFault` query: `minute_quota`, `day_quota`, `auth`, `server`, `timeout`, `slow_stream`, or `cut_stream`. The mock refuses to run when `NODE_ENV` is `production` or `VERCEL_ENV` is set, and the route then uses Gemini. A missing country header stays live only for this local mock. A restricted country still gets canned answers. The quota, auth, server, and timeout faults answer with JSON before the stream opens. `slow_stream` and `cut_stream` still open the stream.
- `DATABASE_URL`: Postgres catalog. Empty off Vercel uses the local database. On Vercel an empty value leaves the catalog unconfigured.
- `CLASSY_BUCKET`: private Cloudflare R2 bucket for media. Empty serves files from disk.
- `CLASSY_R2_ACCOUNT_ID`: R2 account id. Used only to build the signed host.
- `CLASSY_R2_ACCESS_KEY_ID` and `CLASSY_R2_SECRET_ACCESS_KEY`: read-only token for that bucket. The app signs GET links for 10 minutes. Leave both empty to keep reading files from disk.
- `CLASSY_OBJECT_ROOT`: directory for those files. Empty uses `catalog/objects`.
- `CLASSY_MEDIA_SECRET`: HMAC secret for the local disk links. Set this in production. Empty uses the local development default.

Upload uses a different token, `CLASSY_R2_WRITE_ACCESS_KEY_ID` and `CLASSY_R2_WRITE_SECRET_ACCESS_KEY`, and only from this machine. `node scripts/upload-media.mjs` compares sizes and checksums. `node scripts/upload-media.mjs --upload` sends the files that differ. The script refuses to run when `VERCEL` is set or `NODE_ENV` is `production`.

The bucket CORS policy lists exact origins. Video playback does not need CORS. The activation file is fetched by script, so the bucket must allow these origins and expose the range headers:

```json
[
  {
    "AllowedOrigins": [
      "https://classy-v2.vercel.app",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://127.0.0.1:4173",
      "http://localhost:4173"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Accept-Ranges", "Content-Range", "Content-Length", "Content-Type", "ETag"],
    "MaxAgeSeconds": 600
  }
]
```

Live chat also reads the `x-vercel-ip-country` header. Visitors in the EEA, Switzerland, or the UK, and any request with that header missing, are served canned answers instead of Gemini. The privacy note is shown only for a live visitor outside that list.

## Rebuild the catalog database

The source of a rebuild is the local socket database named `classy`. The target is whatever `DATABASE_URL` is set to in the environment for that command. The script refuses a Neon host when `NEON_BRANCH` is missing or `production`, unless that one command sets `CLASSY_ALLOW_PRODUCTION=1`. It does not print the URL.

```bash
# Rows and search text. Embedding vectors stay behind.
NEON_BRANCH=dev scripts/rebuild-catalog.sh

# Same copy, including chunk embeddings, once the target has room for them.
# This truncates the target and reloads every snapshot.
NEON_BRANCH=dev scripts/rebuild-catalog.sh --with-vectors

# Copy embeddings for one snapshot that is already loaded, then rebuild the index.
# This does not truncate and does not bring back other snapshots.
NEON_BRANCH=dev scripts/rebuild-catalog.sh --vectors-only --snapshot ku-20261012T130045Z
```

Set `DATABASE_URL` in the environment before either command. For local Neon work, use the `dev` branch and put that URL only in gitignored `web/.env.local`, with `NEON_BRANCH=dev`. `npm test` does not read that file. It builds a throwaway local database and overwrites `DATABASE_URL`. `web/scripts/search-cli.mjs`, `web/scripts/search-debug.mjs`, and `catalog/pack_snapshot.py` use the same production refusal.

`scripts/readonly-role.sql` creates `classy_reader`, which can select the tables the app reads and cannot insert, update, delete, or change the schema. Set its password in the Neon console. Do not store the connection string in the repo.

## Errors and logs

Every response has `X-Request-Id`. Errors return `{requestId, error, message}` with a message safe to show. The detail goes to the server log as one JSON line per event. Search responses send per-stage timing in `Server-Timing`.
