# Contracts

This file freezes the cross-module and public HTTP contracts for v0.1, plus the v0.2 schema-catalogue contract in §8. Implementations may add private types but must not silently change these meanings.

TypeScript below is normative pseudocode. The architect/integrator will place the executable definitions in `src/contracts/` during the skeleton task.

## 1. Domain values

```ts
export type UserId = string; // canonical UUID string
export type SessionId = string; // canonical UUID string

export interface User {
  id: UserId;
  email: string;
  createdAt: Date;
}

export interface Session {
  id: SessionId;
  userId: UserId;
  tokenHash: Buffer;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AuthenticatedUser {
  id: UserId;
  email: string;
}
```

Password hashes are repository-only data and never appear on the public `User` type.

## 2. Auth repository port

```ts
export interface UserRecord extends User {
  passwordHash: string;
}

export interface AuthRepository {
  createUserAndSession(input: {
    email: string;
    passwordHash: string;
    tokenHash: Buffer;
    expiresAt: Date;
  }): Promise<{ user: User; session: Session }>;

  findByEmail(email: string): Promise<UserRecord | null>;
  createSession(input: {
    userId: UserId;
    tokenHash: Buffer;
    expiresAt: Date;
  }): Promise<Session>;

  findActiveUserByTokenHash(
    tokenHash: Buffer,
    now: Date
  ): Promise<AuthenticatedUser | null>;
  revokeByTokenHash(tokenHash: Buffer, revokedAt: Date): Promise<boolean>;
}
```

`createUserAndSession` is atomic. Unique-email conflicts are translated to the domain error `EMAIL_ALREADY_REGISTERED`; database error details do not leak across the port.

## 3. Auth service

```ts
export interface AuthResult {
  user: User;
  token: string;
  expiresAt: Date;
}

export interface AuthService {
  register(input: { email: string; password: string }): Promise<AuthResult>;
  login(input: { email: string; password: string }): Promise<AuthResult>;
  authenticate(rawToken: string): Promise<AuthenticatedUser>;
  logout(rawToken: string): Promise<void>;
}
```

Rules:

- `register` and `login` each create a fresh session.
- `authenticate` accepts only a syntactically valid token whose session is active and whose user still exists.
- `logout` is idempotent for a validly shaped token; it must not reveal whether a session existed.
- raw tokens never cross into logs or persisted storage.

## 4. Exposed-table registry

```ts
export interface ExposedTable {
  alias: string;
  schema: string;
  table: string;
  primaryKey: "id";
  readableColumns: readonly string[];
  insertableColumns: readonly string[];
  updatableColumns: readonly string[];
}

export interface TableRegistry {
  get(alias: string): ExposedTable | null;
  list(): readonly ExposedTable[];
}
```

The PostgreSQL adapter builds this registry from configuration plus database metadata at startup. Aliases match `^[a-z][a-z0-9_]{0,62}$` and are unique.

## 5. Data service and repository

The data repository boundary uses JSON-ready values. PostgreSQL-to-JSON conversion rules are fixed in `docs/database-spec.md`:

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type DataRow = Record<string, JsonValue>;

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
}

export interface RequestIdentity {
  userId: UserId;
}

export interface DataRepository {
  list(input: {
    identity: RequestIdentity;
    table: ExposedTable;
    limit: number;
    offset: number;
  }): Promise<Page<DataRow>>;

  findById(input: {
    identity: RequestIdentity;
    table: ExposedTable;
    id: string;
  }): Promise<DataRow | null>;

  create(input: {
    identity: RequestIdentity;
    table: ExposedTable;
    values: DataRow;
  }): Promise<DataRow>;

  updateById(input: {
    identity: RequestIdentity;
    table: ExposedTable;
    id: string;
    values: DataRow;
  }): Promise<DataRow | null>;

  deleteById(input: {
    identity: RequestIdentity;
    table: ExposedTable;
    id: string;
  }): Promise<boolean>;
}
```

All five methods perform their query inside a transaction with `microjbase.user_id` set locally. A missing row and an RLS-hidden row are intentionally indistinguishable.

## 6. Error contract

Domain errors have a stable machine code and safe public message.

```ts
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "EMAIL_ALREADY_REGISTERED"
  | "INVALID_CREDENTIALS"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "TABLE_NOT_FOUND"
  | "ROW_NOT_FOUND"
  | "CONFLICT"
  | "DATABASE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface AppError {
  code: ErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}
```

Unexpected errors become `INTERNAL_ERROR`; stack traces and database messages are logged server-side with redaction but never returned.

## 7. HTTP envelope

Successful response:

```json
{
  "data": {},
  "error": null
}
```

List response:

```json
{
  "data": [],
  "error": null,
  "meta": {
    "limit": 50,
    "offset": 0
  }
}
```

Error response:

```json
{
  "data": null,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password"
  }
}
```

`details` is optional and may contain field-level validation information only. It must not contain SQL, stack traces, environment values, hashes, or tokens.

TypeScript domain fields use `camelCase`; HTTP JSON fields use `snake_case`. The HTTP module owns this explicit mapping.

## 8. Schema catalogue (v0.2, V02-01)

Read-only PostgreSQL catalogue introspection. The executable definitions live in `src/contracts/schema.ts` (frozen, dependency-free); the PostgreSQL reader is `src/database/schema-catalogue.ts`.

```ts
export interface TypeIdentity {
  schema: string;
  name: string;
  kind: "base" | "domain" | "enum" | "range" | "multirange" | "composite" | "pseudo";
}

export type SchemaTableKind = "regular" | "partitioned";

/** pg_attribute.attgenerated: '' -> none, 's' -> stored, 'v' -> virtual (PG 18+). */
export type ColumnGeneratedKind = "none" | "stored" | "virtual";

export type ColumnIdentityKind = "none" | "always" | "by_default";

export interface SchemaCatalogueColumn {
  ordinal: number; // pg_attribute.attnum
  name: string;
  isNullable: boolean;
  /** pg_get_expr text, or null. Always null for generated columns. */
  defaultExpression: string | null;
  generated: ColumnGeneratedKind;
  identity: ColumnIdentityKind;
  renderedType: string; // format_type(atttypid, atttypmod)
  type: TypeIdentity; // declared type; a declared domain stays a domain
  /**
   * Immediate pg_type.typbasetype of the declared type, present if and only
   * if the declared type is a domain. The immediate base may itself be a
   * domain; the reader does not recurse.
   */
  baseType: TypeIdentity | null;
}

export interface SchemaCatalogueTable {
  schema: string;
  name: string;
  owner: string;
  kind: SchemaTableKind;
  hasRowSecurity: boolean; // pg_class.relrowsecurity
  hasForcedRowSecurity: boolean; // pg_class.relforcerowsecurity
  columns: readonly SchemaCatalogueColumn[];
}

export interface SchemaCatalogueSchema {
  name: string;
  owner: string;
  tables: readonly SchemaCatalogueTable[];
}

export interface SchemaCatalogue {
  schemas: readonly SchemaCatalogueSchema[]; // sorted by name
}

export interface SchemaCatalogueReader {
  read(): Promise<SchemaCatalogue>;
}
```

Reader guarantees:

- Exactly one static read-only `SELECT` per `read()` — no parameters, no interpolation — so the result comes from a single PostgreSQL snapshot. The statement pins `search_path` to `pg_catalog` transaction-locally, so rendered type/default expressions are deterministic regardless of the caller's `search_path`.
- Schemas are the non-system schemas (`information_schema` and `pg_%` excluded, which also covers `pg_toast`/`pg_temp_*`); only `relkind IN ('r','p')` tables are reported. Empty schemas and zero-column tables appear with empty arrays.
- Output ordering is deterministic: schemas by name, tables by name within a schema, columns by ordinal within a table.
- Fail-closed mapping: malformed rows, rows carrying fields of another row kind, duplicate schema names, duplicate table keys, duplicate column ordinals/names, and orphan tables/columns (a row whose parent is absent from the read) all raise `INTERNAL_ERROR`; nothing is fabricated or silently dropped. Dependency errors pass through the existing safe database error translation boundary.
- `defaultExpression` is rendered `pg_get_expr` text as observed by PostgreSQL; the reader never parses or executes it. A generated column's `pg_attrdef` entry is its generation expression, so `defaultExpression` is always `null` for `stored` and `virtual` generated columns.

Known limitation: an attached partition child has `pg_class.relkind 'r'`, so it currently appears as a separate regular table rather than being classified as a partition of its parent.

## 9. Contract-change process

A proposed change to this file or `src/contracts/` must include:

1. the problem the current contract cannot solve;
2. affected modules and tests;
3. compatibility/security consequences;
4. a decision entry in `DECISIONS.md` if accepted.

Module agents report the proposal and stop at the boundary. Only the architect/integrator merges the contract change.
