-- Migration 0005: durable schema-operation history (v0.2, V02-05).
--
-- Forward-only and immutable after merge. Written only by the schema-admin
-- module through the operation-log repository; never by request handlers.
-- The idempotency_key unique constraint is the concurrency boundary: two
-- concurrent operations with the same key race for one row, and the loser
-- observes the winner's record instead of duplicating work.
--
-- The checksum detects an idempotency key replayed with a different command;
-- the actor fingerprint is a salted SHA-256 of the actor label so no raw
-- actor identity (token material, future operator identifiers) ever persists.

CREATE TABLE IF NOT EXISTS microjbase.schema_operations (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  command_type TEXT NOT NULL,
  command JSONB NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  actor_fingerprint TEXT NOT NULL,
  error_code TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS schema_operations_created_at_idx
  ON microjbase.schema_operations (created_at DESC);

COMMENT ON TABLE microjbase.schema_operations IS
  'Durable schema-operation history with idempotency and checksums.';
