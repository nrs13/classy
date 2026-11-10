-- Current snapshot is the only one the app reads. Older snapshots stay, so the pointer can move back.
-- Packing never moves the pointer; pack_snapshot.py --promote does, after --validate passes.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS snapshot (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  complete boolean NOT NULL DEFAULT false,
  embedding_model text,
  embedding_dim integer,
  quote_floor real NOT NULL DEFAULT 0.5
);

CREATE TABLE IF NOT EXISTS pointer (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  snapshot_id text REFERENCES snapshot (id)
);

INSERT INTO pointer (id, snapshot_id)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS clip (
  video_id text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot (id),
  duration real,
  language text,
  account text,
  plays double precision,
  likes double precision,
  comments double precision,
  followers double precision,
  like_rate double precision,
  amplification double precision,
  hook_slope double precision,
  peak_mean_abs double precision,
  sustain_ratio double precision,
  timing_eligible boolean NOT NULL DEFAULT false,
  cuts jsonb NOT NULL DEFAULT '[]'::jsonb,
  curve jsonb NOT NULL DEFAULT '[]'::jsonb,
  mp4_object text,
  act_object text,
  frames integer,
  topics text,
  keywords text,
  PRIMARY KEY (snapshot_id, video_id)
);

CREATE TABLE IF NOT EXISTS second (
  video_id text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot (id),
  t_sec integer NOT NULL,
  speech text,
  speech_score real,
  text_on_screen jsonb,
  speaker text,
  labels jsonb,
  face_count integer,
  music_score real,
  sentiment jsonb,
  scenes jsonb,
  outcomes jsonb,
  app jsonb,
  ask jsonb,
  PRIMARY KEY (snapshot_id, video_id, t_sec)
);

CREATE TABLE IF NOT EXISTS chunk (
  id bigserial PRIMARY KEY,
  video_id text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot (id),
  t_sec integer NOT NULL,
  field text NOT NULL,
  text text NOT NULL,
  embedding vector,
  model text,
  dimension integer,
  confidence real,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED
);

CREATE INDEX IF NOT EXISTS chunk_snapshot_tsv ON chunk USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunk_snapshot_video ON chunk (snapshot_id, video_id, t_sec);

CREATE TABLE IF NOT EXISTS event (
  id bigserial PRIMARY KEY,
  video_id text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot (id),
  source text NOT NULL,
  start_sec double precision,
  end_sec double precision,
  tags jsonb,
  text text,
  evidence text,
  score real
);

CREATE INDEX IF NOT EXISTS event_snapshot_video ON event (snapshot_id, video_id);

-- Search additions. Additive only, so older snapshots keep working with NULLs.
ALTER TABLE snapshot ADD COLUMN IF NOT EXISTS embedding_profile text;
ALTER TABLE chunk ADD COLUMN IF NOT EXISTS end_sec integer;
ALTER TABLE chunk ADD COLUMN IF NOT EXISTS speaker text;
ALTER TABLE chunk ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE chunk ADD COLUMN IF NOT EXISTS context jsonb;

CREATE INDEX IF NOT EXISTS chunk_snapshot_field ON chunk (snapshot_id, field);
CREATE INDEX IF NOT EXISTS chunk_snapshot_language ON chunk (snapshot_id, language);

-- One vector per distinct formatted document text and embedding profile.
CREATE TABLE IF NOT EXISTS embedding_cache (
  profile text NOT NULL,
  text_hash text NOT NULL,
  vector vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile, text_hash)
);

-- What a typed query means (English rewrite, requested languages, kind), per model.
CREATE TABLE IF NOT EXISTS query_understanding (
  model text NOT NULL,
  query_norm text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, query_norm)
);

-- Frame sprite per video: one JPEG of evenly spaced frames plus its grid.
ALTER TABLE clip ADD COLUMN IF NOT EXISTS sprite_object text;
ALTER TABLE clip ADD COLUMN IF NOT EXISTS sprite_meta jsonb;

-- Whether a clip counts toward the timing set; the 78 rule is applied per snapshot.
ALTER TABLE clip ADD COLUMN IF NOT EXISTS timing_candidate boolean;


-- Every promotion and rollback of the pointer.
CREATE TABLE IF NOT EXISTS pointer_history (
  id bigserial PRIMARY KEY,
  from_snapshot text REFERENCES snapshot (id),
  to_snapshot text NOT NULL REFERENCES snapshot (id),
  at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest (
  video_id text PRIMARY KEY,
  url text,
  state text NOT NULL,
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_state CHECK (
    state IN (
      'queued',
      'downloaded',
      'tribe_ok',
      'vi_ok',
      'models_ok',
      'packed',
      'failed',
      'blocked'
    )
  )
);

-- Whole-query substring matching for text the word parser cannot split (Japanese, glued names).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS chunk_text_trgm ON chunk USING gin (text gin_trgm_ops);

-- Ingest state machine (pack_snapshot.py docstring). Older states stay valid for old rows.
ALTER TABLE ingest DROP CONSTRAINT IF EXISTS ingest_state;
ALTER TABLE ingest ADD CONSTRAINT ingest_state CHECK (
  state IN (
    'queued', 'fetching', 'tribe', 'indexing', 'packing', 'validating', 'live', 'failed', 'blocked',
    'downloaded', 'tribe_ok', 'vi_ok', 'models_ok', 'packed'
  )
);

-- Yeo-7 means, top three names, and peak time. Label 0 (medial wall) is excluded.
ALTER TABLE clip ADD COLUMN IF NOT EXISTS networks jsonb;

-- A scene or on-screen line repeats for every second it lasts. Only its first second is in
-- the vector index: repeats would fill the nearest neighbours with copies of one line.
-- pack_snapshot.mark_repeats sets the flag; unmarked rows stay searchable.
ALTER TABLE chunk ADD COLUMN IF NOT EXISTS is_repeat boolean NOT NULL DEFAULT false;

-- Vectors are about 4 KB and live in TOAST, so a full scan is slow. One HNSW index per
-- dimension in use; the search query repeats this cast and both predicates.
DROP INDEX IF EXISTS chunk_embedding_1024_hnsw;
CREATE INDEX IF NOT EXISTS chunk_embedding_1024_first_hnsw ON chunk
  USING hnsw ((embedding::vector(1024)) vector_cosine_ops) WHERE dimension = 1024 AND NOT is_repeat;
