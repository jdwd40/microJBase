-- Migration 0003: enforce UNIQUE on sessions.token_hash.
--
-- Migration 0002 created a non-unique index (idx_sessions_token_hash).
-- Session token hashes must be unique so findActiveUserByTokenHash can
-- rely on at most one matching row. Drop the old index and add a named
-- UNIQUE constraint for clear PostgreSQL error reporting.

DROP INDEX IF EXISTS microjbase.idx_sessions_token_hash;

ALTER TABLE microjbase.sessions
  ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);
