# Contracts

This file freezes the cross-module and public HTTP contracts for v0.1. Implementations may add private types but must not silently change these meanings.

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

## 8. Contract-change process

A proposed change to this file or `src/contracts/` must include:

1. the problem the current contract cannot solve;
2. affected modules and tests;
3. compatibility/security consequences;
4. a decision entry in `DECISIONS.md` if accepted.

Module agents report the proposal and stop at the boundary. Only the architect/integrator merges the contract change.
