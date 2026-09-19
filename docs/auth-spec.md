# Authentication Specification

## Identity

An email address is a case-insensitive login identifier, not a verified communication channel.

Normalisation:

1. trim leading/trailing ASCII whitespace;
2. Unicode-normalise to NFC;
3. lowercase the entire address;
4. validate a pragmatic address shape and maximum 254 UTF-8 bytes.

microJBase does not send email and does not claim ownership of the address.

## Passwords

- Minimum 10 characters, maximum 128 characters.
- No arbitrary composition rules.
- Reject control characters and NUL.
- Do not trim or otherwise transform an accepted password.
- Hash with Argon2id using explicit parameters stored in the encoded hash.
- Initial minimum: 19 MiB memory, 2 iterations, parallelism 1; benchmark before release and raise only if the target VPS remains responsive.
- Never log, echo, or persist plaintext passwords.

Login must perform a dummy Argon2id verification when the email is unknown so the obvious user-enumeration timing difference is reduced. Public errors remain identical.

## Session token

Generation:

- 32 cryptographically random bytes from Node's `crypto.randomBytes`;
- base64url without padding for transport;
- SHA-256 digest stored as binary in PostgreSQL;
- raw token returned once and held only for the current request lifetime.

The token carries no claims. The default lifetime is seven days, configurable in seconds. There is no refresh token in v0.1; login creates a new session.

Authentication hashes the presented token and uses the auth repository to resolve the user only when `revoked_at IS NULL` and `expires_at > now`. Expired sessions may be deleted later by an operator; background cleanup is outside v0.1.

## Logout

Logout sets `revoked_at` for the current token digest. It is immediate and idempotent. Logging out one session does not revoke the user's other sessions.

Registration inserts the user and initial session in one database transaction. If either insert fails, neither persists.

## Storage schema

Conceptual schema (the migration agent owns exact SQL):

```sql
CREATE SCHEMA microjbase;

CREATE TABLE microjbase.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique
  ON microjbase.users (email);

CREATE TABLE microjbase.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES microjbase.users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
```

Normalisation occurs in the application before the unique constraint. A later migration may use `citext`; it is not required for v0.1.

## Rate limiting

Register and login use a small bounded in-memory fixed-window limiter keyed by trusted client IP:

- default 10 attempts per endpoint per IP per minute;
- maximum entry count with oldest-expiry eviction;
- entries expire without background timers that retain unbounded state;
- return `429 RATE_LIMITED` and `Retry-After`.

`TRUST_PROXY=false` by default. Operators behind a known reverse proxy must explicitly configure it. Distributed enforcement is out of scope.

Rate limiting reduces casual abuse; it is not a substitute for reverse-proxy/network controls.

## Security invariants

- Duplicate registration may return `EMAIL_ALREADY_REGISTERED`; login never confirms whether an email exists.
- Password and token comparisons use the relevant library primitives, not handwritten equality loops.
- Tokens, passwords, hashes, and database URLs are redacted from structured logs and error metadata.
- Auth responses use `Cache-Control: no-store`.
- Sessions survive process restarts.
- An expired or revoked token never reaches the data service.

## Deferred

Email verification, password reset/change, MFA, OAuth, account deletion, account lockout, session management UI, refresh tokens, and JWTs are not v0.1 work.
