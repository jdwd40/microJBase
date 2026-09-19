# Database Specification

## Supported database

PostgreSQL 16 or newer. v0.1 uses one database containing:

- the private `microjbase` schema for users, sessions, and migration metadata;
- application-owned schemas/tables;
- a restricted runtime role used by the API.

## Connections and roles

`MIGRATION_DATABASE_URL` is used only by the explicit migration command. It owns or can alter microJBase objects.

`DATABASE_URL` is used by the running API. On startup, the server verifies that its current role:

- is not a superuser;
- does not have `BYPASSRLS`;
- can read/write the required auth tables;
- can access every configured exposed table;
- is not the owner of an exposed table unless that table has forced RLS (forced RLS is required regardless).

The server exits non-zero on an unsafe or incomplete configuration.

Pool default maximum is 10 connections. Pool acquisition and query timeouts must be finite and configurable only if real deployment evidence requires new settings.

## Migrations

- Files are named `NNNN_description.sql`, starting at `0001`.
- Applied versions are stored in `microjbase.schema_migrations` with filename, checksum, and timestamp.
- The runner obtains a PostgreSQL advisory lock so only one migrator runs.
- A changed checksum for an applied migration is a fatal error.
- Each migration runs in a transaction unless it explicitly documents why PostgreSQL forbids it.
- Migrations are forward-only for v0.1; backup/restore is the rollback path.
- The API does not automatically run privileged migrations at startup.

## Exposed table configuration

Format:

```text
MICROJBASE_TABLES=todos=public.todos,profiles=app.profiles
```

Each item is `alias=schema.table`. Whitespace is trimmed. Duplicate aliases/targets, invalid identifiers, reserved schemas, and missing tables fail startup.

Client routes contain only `alias`. The adapter uses schema/table values from the verified registry, safely quoted with a single audited identifier helper. Request values remain PostgreSQL parameters.

## Required table shape

Every exposed table has:

- a single primary key column named `id` of type `uuid`;
- row-level security enabled;
- forced row-level security enabled;
- at least one applicable policy for the runtime role;
- grants appropriate to the desired CRUD operations.

Recommended user-owned table:

```sql
CREATE TABLE public.todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT (
    nullif(current_setting('microjbase.user_id', true), '')::uuid
  ) REFERENCES microjbase.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todos FORCE ROW LEVEL SECURITY;

CREATE POLICY todos_owner_all ON public.todos
  FOR ALL
  TO microjbase_runtime
  USING (
    user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid
  );
```

The exact runtime role name may be operator-selected; migrations/examples must not assume that roles can be created on every managed PostgreSQL provider.

## Request identity transaction

Every data repository method follows this sequence on one checked-out pool client:

```sql
BEGIN;
SELECT set_config('microjbase.user_id', $1, true);
-- exactly one CRUD operation using parameterised values
COMMIT;
```

On any failure it runs `ROLLBACK` before releasing the client. The third `set_config` argument is `true`, making the value transaction-local. Tests must prove a subsequent borrower of the same pooled connection sees no previous identity.

Auth repository operations do not set this identity and do not use the generic data repository.

## Metadata registry

At startup the adapter queries PostgreSQL catalogues and stores immutable metadata for configured tables:

- verified schema, table, UUID primary key, and RLS flags;
- column names, data types, nullability, defaults, generated/identity status;
- privileges for the runtime role.

Derived lists:

- readable: columns with SELECT privilege;
- insertable: INSERT privilege, excluding generated/identity columns;
- updatable: UPDATE privilege, excluding `id`, generated, and identity columns.

Unknown or non-writable body keys produce `VALIDATION_ERROR` before SQL execution. Empty insert/patch bodies are rejected. The API does not accept SQL expressions as values.

### Supported column values

v0.1 exposes only columns that can be converted predictably to JSON:

| PostgreSQL type | HTTP JSON representation |
|---|---|
| `uuid`, `text`, `varchar`, `char` | string |
| `boolean` | boolean |
| `smallint`, `integer`, `real`, `double precision` | number |
| `bigint`, `numeric`, `decimal` | string, preserving precision |
| `date`, `timestamp`, `timestamptz` | ISO 8601 string |
| `json`, `jsonb` | corresponding JSON value |

Unsupported types—including `bytea`, arrays, ranges, geometric types, composites, and custom types—are excluded from the registry's readable/insertable/updatable lists. If that makes a configured table unusable, startup fails with a precise operator-facing error. Database adapters return JSON-ready values; `Date`, `Buffer`, `bigint`, `NaN`, and infinity must never cross the data repository contract.

## CRUD rules

- Lists order by `id ASC`, then apply parameterised `LIMIT`/`OFFSET`.
- Reads, updates, and deletes use `WHERE id = $n`.
- Inserts/updates return the database row using `RETURNING` and only readable columns.
- RLS-hidden and missing rows are indistinguishable.
- Constraint names and raw database messages are not exposed. Known conflicts map to the safe `CONFLICT` error.
- Multiple-row insert/update/delete is not supported.

## Backups

v0.1 documentation must use `pg_dump`/`pg_restore` and verify restoration into a fresh database. The API stores no local files, so PostgreSQL is the entire durable state.
