-- Migration 0001: create the private microjbase schema and migration registry.
--
-- This migration is idempotent where safe (CREATE IF NOT EXISTS) so that
-- repeated application against the same database does not fail. The runtime
-- role is intentionally not created here; managed providers often forbid
-- CREATE ROLE, so operators create roles separately and grant appropriately.

CREATE SCHEMA IF NOT EXISTS microjbase;

-- Tracks applied migrations. The checksum column detects tampering with
-- already-applied files.
CREATE TABLE IF NOT EXISTS microjbase.schema_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE microjbase.schema_migrations IS
  'Forward-only migration registry for microJBase.';
