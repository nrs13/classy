-- Read-only role for the Classy web app.
-- Run this as the database owner. Set the password in the Neon console.
-- Do not put a password or a connection string in this file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'classy_reader') THEN
    CREATE ROLE classy_reader
      WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE neondb TO classy_reader;

REVOKE ALL ON SCHEMA public FROM classy_reader;
GRANT USAGE ON SCHEMA public TO classy_reader;
REVOKE CREATE ON SCHEMA public FROM classy_reader;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM classy_reader;
GRANT SELECT ON
  clip,
  ingest,
  second,
  chunk,
  embedding_cache,
  query_understanding,
  pointer,
  snapshot
TO classy_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM classy_reader;
