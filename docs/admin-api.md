# Admin API Specification (v0.2, V02-16..V02-18)

The admin API is the opt-in operator surface for schema management. It exists
only when **both** `SCHEMA_DATABASE_URL` and `MICROJBASE_ADMIN_TOKEN_SHA256`
are configured (D-012); with either one missing the server fails startup, and
with neither the `/v1/admin` route tree is not registered at all — those paths
return the plain `404 TABLE_NOT_FOUND` of the public surface. This document
matches the implemented behaviour exactly; there is no generator dependency.

Base path: `/v1/admin`. JSON is UTF-8. All rules of
[api-spec.md](api-spec.md) apply unless restated here.

## Authentication and common behaviour

Every admin endpoint requires `Authorization: Bearer <operator-token>` (D-013):

- the token is a single operator secret; its SHA-256 digest is the configured
  `MICROJBASE_ADMIN_TOKEN_SHA256`;
- verification is a constant-time digest comparison (`timingSafeEqual` on the
  SHA-256 of the presented token);
- a missing or malformed bearer header returns `401 AUTH_REQUIRED`; a
  well-formed but wrong token (including every ordinary session token, and
  the operator token used against `/v1/auth` or `/v1/data`) returns
  `401 INVALID_CREDENTIALS`;
- the raw operator token is never stored, logged, or echoed; the digest is
  redacted from configuration logs.

Every admin response — success, client error, and Fastify pre-route failures —
carries `Cache-Control: no-store`. Error responses use the frozen envelope
from [CONTRACTS.md](../CONTRACTS.md) and never contain SQL, SQLSTATEs, stack
traces, or database internals.

Rate limiting is separate from the auth limiter: a dedicated bounded
fixed-window limiter (30 attempts per endpoint per client IP per 60-second
window) protects the whole tree. Over-limit responses are
`429 RATE_LIMITED` with `Retry-After`. The per-client-IP key resolves the
same way as every other client IP in the server: with `TRUST_PROXY`
enabled the address comes from `X-Forwarded-For`, so it is spoofable by
clients unless the proxy overwrites that header. The default `TRUST_PROXY`
is `false`.

## Operator prerequisites

1. A dedicated PostgreSQL role for the schema-admin lane (created by the
   operator out of band): `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE`, owning
   every table it mutates. `SCHEMA_DATABASE_URL` connects as this role and
   must never equal `DATABASE_URL` (checked at startup both as a URL and as a
   live session, D-024/D-011).
2. Out-of-band grants in the application database (migrations 0005/0006
   cannot grant to a role that did not exist at migration time):

   ```sql
   GRANT USAGE ON SCHEMA microjbase TO <schema_admin_role>;
   GRANT SELECT ON microjbase.schema_migrations TO <schema_admin_role>;
   GRANT SELECT, INSERT, UPDATE ON microjbase.schema_operations TO <schema_admin_role>;
   GRANT USAGE ON SEQUENCE microjbase.schema_operations_id_seq TO <schema_admin_role>;
   GRANT SELECT, INSERT, UPDATE ON microjbase.exposure_registry TO <schema_admin_role>;
   GRANT USAGE ON SEQUENCE microjbase.exposure_registry_id_seq TO <schema_admin_role>;
   GRANT SELECT ON microjbase.exposure_registry_state TO <schema_admin_role>;
   ```

   `schema_migrations` read access is what the deterministic snapshot reports
   as migration history; `schema_operations` and `exposure_registry` writes
   are recorded through the same audited executor as every other mutation
   (D-025/D-028). Startup probes fail closed with operator-facing messages
   when any grant is missing.
3. A CREATE-capable schema owned by the schema-admin role (for example
   `CREATE SCHEMA app AUTHORIZATION <schema_admin_role>`), or `CREATE` granted
   on an existing operator schema. Tables created through the API are owned
   by the schema-admin role.
4. `MICROJBASE_ADMIN_TOKEN_SHA256` set to the lowercase hex SHA-256 digest of
   the operator token (64 characters; malformed digests fail startup).

## Read-only endpoints

### `GET /v1/admin/schema/capabilities`

The V02-16 probe: authenticates the operator and checks the admin pool with a
trivial query. Returns `200`:

```json
{ "data": { "status": "ok", "database": "ok" }, "error": null }
```

`503 DATABASE_UNAVAILABLE` when the admin lane's database is unreachable.

### `GET /v1/admin/schema`

The whole deterministic schema snapshot (V02-03 contract): non-system schemas
with their tables, columns, constraints, indexes, owners, RLS state, per-table
`classification` (`internal` objects are reported but never manageable) and
`exposure` (`{ "exposed": boolean, "alias": string | null }`), plus the
`microjbase.schema_migrations` history. Ordering is deterministic, so repeated
reads are byte-identical.

### `GET /v1/admin/schema/tables/:schema/:table`

One table detail derived from the same snapshot. Unknown tables return
`404 TABLE_NOT_FOUND`.

### `GET /v1/admin/schema/history?limit=&offset=`

Durable operation history (D-025), newest first. `limit` defaults to 50
(1..500); `offset` defaults to 0. Records are snake_case:

```json
{
  "data": [
    {
      "id": 7,
      "idempotency_key": "2026-09-25-create-todos",
      "command_type": "schema.table.create",
      "command": { "schema": "app", "table": "todos", "columns": [] },
      "checksum": "…",
      "status": "succeeded",
      "actor_fingerprint": "…",
      "error_code": null,
      "result": {},
      "created_at": "2026-09-25T12:00:00.000Z",
      "finished_at": "2026-09-25T12:00:00.100Z"
    }
  ],
  "error": null,
  "meta": { "limit": 50, "offset": 0 }
}
```

`actor_fingerprint` is a salted SHA-256 over the fixed HTTP operator identity;
raw actor labels never appear.

## Mutating endpoints

Common rules for every mutating endpoint:

- **Idempotency-Key header (required).** Must match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`. Missing or malformed keys return
  `400 VALIDATION_ERROR` — there is no un-keyed mutation path. Reusing a key
  replays the recorded outcome (`replayed: true`) without re-executing;
  reusing a key with a different command returns `409 CONFLICT` (D-025).
- **Strict bodies.** Unknown JSON fields are rejected with
  `400 VALIDATION_ERROR`. Fields are typed and snake_case; the server maps
  them onto the frozen camelCase command shapes. HTTP handlers never
  construct SQL; every command compiles through the single audited DDL layer
  (D-014/D-026) and maps PostgreSQL errors to safe envelopes.
- **`dry_run`.** Optional boolean on every mutation. A dry run compiles and
  preflights inside a transaction that always rolls back: no history row, no
  state change. Responses set `"dry_run": true` and `"record": null`.
- **Responses.** `200` with `{ "dry_run": boolean, "replayed": boolean, "record": <history record> | null }`.
- **Confirmations.** Destructive commands require an exact confirmation value
  (D-015), validated again inside the service on first execution; a replay
  returns the recorded outcome without re-confirmation.
- **Exposure guard.** Structural mutation of an exposed table fails closed
  (`409 CONFLICT`) in the executor even if an early gate was bypassed
  (D-033/D-035); the friendly preflight reports the same refusal earlier.

### Tables

`POST /v1/admin/schema/tables` — create (the managed `"id" uuid` primary key
is appended automatically; operator columns may not use `id`):

```json
{
  "schema": "app",
  "table": "todos",
  "columns": [
    {
      "name": "title",
      "type": "text",
      "nullable": false,
      "default": { "kind": "literal", "value": "untitled" }
    }
  ]
}
```

Column types are the frozen allowlist: `text`, `integer`, `bigint`,
`boolean`, `uuid`, `timestamp`, `timestamptz`, `date`, `numeric`, `jsonb`.
Defaults are the frozen template model — `{ "kind": "none" }`,
`{ "kind": "literal", "value": <JSON primitive> }`,
`{ "kind": "current_timestamp" }`, `{ "kind": "random_uuid" }` — never
arbitrary SQL.

`POST /v1/admin/schema/tables/:schema/:table/rename` — `{ "new_name": "…" }`.

`POST /v1/admin/schema/tables/:schema/:table/drop` —
`{ "confirm": "<schema>.<table>" }`. Refuses exposed tables, tables referenced
by another table's foreign key, and internal targets.

### Columns

- `POST /v1/admin/schema/tables/:schema/:table/columns` — `{ "column": <column spec> }`.
- `POST …/columns/:column/rename` — `{ "new_name": "…" }`.
- `POST …/columns/:column/drop` — `{ "confirm": "<schema>.<table>.<column>" }`.
- `POST …/columns/:column/default` — `{ "default": <default template> }`.
- `POST …/columns/:column/default/drop` — `{}`.
- `POST …/columns/:column/not-null` — `{}`.
- `POST …/columns/:column/nullable` — `{}`.
- `POST …/columns/:column/type` — `{ "to_type": "<allowlist type>" }`, only
  for the frozen safe-conversion matrix (`integer→bigint`,
  `integer→numeric`, `bigint→numeric`, `date→timestamp`); anything else
  returns `400 VALIDATION_ERROR`.

### Indexes and constraints

- `POST /v1/admin/schema/tables/:schema/:table/indexes` —
  `{ "columns": ["…"], "name": "…" (optional) }`.
- `POST …/indexes/:name/drop` — `{}` (constraint-backed names must be dropped
  via the constraint).
- `POST …/unique-constraints` — `{ "columns": ["…"], "name": "…" (optional) }`.
- `POST …/constraints/:name/drop` — `{}`. Primary-key, check, and exclusion
  constraints are never manageable and refuse here.
- `POST …/foreign-keys` —

  ```json
  {
    "columns": ["owner_id"],
    "references": { "schema": "app", "table": "users", "columns": ["id"] },
    "on_update": "no_action",
    "on_delete": "cascade",
    "name": "… (optional)"
  }
  ```

  Actions are frozen to `no_action`, `restrict`, `cascade`, `set_null`;
  `set_default` has no representation. `set_null` compiles only on nullable
  referencing columns. Exposed-table ends refuse with `409 CONFLICT`.

### Exposure

- `POST /v1/admin/schema/exposure` — `{ "schema": "…", "table": "…", "alias": "…" }`.
- `POST /v1/admin/schema/unexpose` — `{ "schema": "…", "table": "…" }`.

Expose verifies the managed shape (UUID `id` primary key, supported columns,
RLS enabled and forced, exactly the module-owned ownership policies for every
command the runtime role exercises) and applies the least-privilege grants in
the same transaction as the durable registry row; the runtime table registry
is rebuilt atomically after commit (D-031/D-035). The alias is reachable at
`/v1/data/:alias` immediately after a successful expose.

### RLS and ownership policies

- `POST /v1/admin/schema/rls/enable` — `{ "schema": "…", "table": "…" }`
  (enables and forces row security in one plan).
- `POST /v1/admin/schema/rls/disable` —
  `{ "schema": "…", "table": "…", "confirm": "<schema>.<table>" }`. Fails
  closed while the table is exposed (D-033).
- `POST /v1/admin/schema/policies` —
  `{ "schema": "…", "table": "…", "column": "…", "template": "read" | "insert" | "update" | "delete" }`.
- `POST /v1/admin/schema/policies/remove` — same body.

Policies bind the named UUID ownership column to the transaction-local
`microjbase.user_id` identity over the frozen ownership template; arbitrary
policy expressions do not exist (D-019/D-034).

## Status mapping

All codes are the frozen set from [CONTRACTS.md](../CONTRACTS.md):
`400 VALIDATION_ERROR`, `401 AUTH_REQUIRED`, `401 INVALID_CREDENTIALS`,
`404 TABLE_NOT_FOUND`, `409 CONFLICT`, `429 RATE_LIMITED`,
`500 INTERNAL_ERROR`, `503 DATABASE_UNAVAILABLE`. Internal SQL errors —
including every guard SQLSTATE (`9C001`..`9C004`) and privilege failures —
surface only as these safe envelopes.
