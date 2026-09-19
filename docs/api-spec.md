# HTTP API Specification

Base path: `/v1`. JSON is UTF-8. All request bodies use `Content-Type: application/json`.

## Common rules

- Unknown JSON fields are rejected on auth endpoints.
- Default maximum body size is 1 MiB.
- Data endpoints require `Authorization: Bearer <session-token>`.
- UUID path values must be canonical UUID strings.
- Dates are returned as ISO 8601 UTC strings.
- `Cache-Control: no-store` is returned on auth responses.
- A request correlation ID is returned as `x-request-id`, but secrets never appear in logs.

Success:

```json
{ "data": {}, "error": null }
```

Failure:

```json
{
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": { "email": "Must be a valid email address" }
  }
}
```

## Health

### `GET /health`

No authentication. Returns `200` only when the process and a trivial database query are healthy.

```json
{
  "data": {
    "status": "ok",
    "database": "ok"
  },
  "error": null
}
```

Returns `503 DATABASE_UNAVAILABLE` when PostgreSQL is unavailable. It exposes no version, host, database name, or credentials.

## Authentication

### `POST /v1/auth/register`

Request:

```json
{ "email": "alice@example.com", "password": "correct horse battery staple" }
```

Returns `201`:

```json
{
  "data": {
    "user": {
      "id": "7ba3e2ac-2d28-4b65-bb2c-2c882f04cd62",
      "email": "alice@example.com",
      "created_at": "2026-09-19T17:00:00.000Z"
    },
    "token": "<opaque-token>",
    "expires_at": "2026-09-26T17:00:00.000Z"
  },
  "error": null
}
```

Errors: `400 VALIDATION_ERROR`, `409 EMAIL_ALREADY_REGISTERED`, `429 RATE_LIMITED`, `503 DATABASE_UNAVAILABLE`.

### `POST /v1/auth/login`

Same request and successful shape as register; returns `200`. A wrong email and wrong password both return `401 INVALID_CREDENTIALS` with the same public message.

### `POST /v1/auth/logout`

Requires a syntactically valid bearer token. Returns `204` with no body. Calling logout with an unknown, expired, or already revoked but validly shaped token also returns `204`; a malformed/missing bearer header returns `401 AUTH_REQUIRED`.

### `GET /v1/auth/me`

Requires bearer authentication. Returns `200`:

```json
{
  "data": {
    "id": "7ba3e2ac-2d28-4b65-bb2c-2c882f04cd62",
    "email": "alice@example.com"
  },
  "error": null
}
```

## Data

`:table` is an exposed alias, not a SQL table name. Unknown and unexposed aliases return `404 TABLE_NOT_FOUND`.

### `GET /v1/data/:table`

Query:

- `limit`: integer 1–100, default 50
- `offset`: integer 0 or greater, default 0, maximum 100000

Rows use stable ascending `id` order in v0.1.

Returns `200`:

```json
{
  "data": [{ "id": "...", "title": "First todo" }],
  "error": null,
  "meta": { "limit": 50, "offset": 0 }
}
```

No total count is calculated in v0.1.

### `GET /v1/data/:table/:id`

Returns `200` with one row, or `404 ROW_NOT_FOUND`. An RLS-hidden row also returns `404`.

### `POST /v1/data/:table`

Body is one non-empty flat JSON object. Nested JSON values are permitted only where the target PostgreSQL column accepts them. `id` may be omitted for a database default; if supplied, it must be a UUID and insertable according to metadata policy.

Returns `201` with the inserted row after RLS and database defaults.

### `PATCH /v1/data/:table/:id`

Body is one non-empty flat JSON object. The primary key `id` cannot be changed. Returns `200` with the updated row or `404 ROW_NOT_FOUND`.

### `DELETE /v1/data/:table/:id`

Returns `204` when deleted. Returns `404 ROW_NOT_FOUND` when missing or hidden by RLS.

## Status mapping

| Status | Code | Meaning |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | Malformed path/query/body or unknown/non-writable column |
| 401 | `AUTH_REQUIRED` | Missing, malformed, unknown, expired, or revoked session |
| 401 | `INVALID_CREDENTIALS` | Login failed |
| 404 | `TABLE_NOT_FOUND` | Alias is not exposed |
| 404 | `ROW_NOT_FOUND` | Row is absent or hidden |
| 409 | `EMAIL_ALREADY_REGISTERED` | Normalised email already exists |
| 409 | `CONFLICT` | Constraint conflict safe to disclose generically |
| 413 | `VALIDATION_ERROR` | Body exceeds configured maximum |
| 429 | `RATE_LIMITED` | Auth rate limit exceeded |
| 500 | `INTERNAL_ERROR` | Unexpected failure |
| 503 | `DATABASE_UNAVAILABLE` | PostgreSQL unavailable |

