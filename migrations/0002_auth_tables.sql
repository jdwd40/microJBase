-- Migration 0002: authentication tables.
--
-- Users and sessions live in the private microjbase schema. Only the
-- migration role owns these objects; the runtime role receives grants via
-- the application setup instructions or a separate provisioning script.

CREATE TABLE IF NOT EXISTS microjbase.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS microjbase.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES microjbase.users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash
  ON microjbase.sessions(token_hash);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id
  ON microjbase.sessions(user_id)
  WHERE revoked_at IS NULL;
