// Durable schema-operation history and idempotency for microJBase v0.2
// (V02-05).
//
// Every controlled schema mutation is recorded in microjbase.schema_operations
// (migration 0005) with a checksum of its typed command, an idempotency key,
// a terminal status, and a safe actor fingerprint. The repository defines the
// replay/conflict semantics the executor relies on:
//
// - begin() with an unused key records a 'running' operation and returns
//   "accepted" so the caller executes the work.
// - begin() with a key whose recorded operation succeeded (same checksum)
//   returns "replay": the caller must NOT re-execute and returns the recorded
//   outcome instead.
// - begin() with a key whose recorded operation failed (same checksum)
//   returns "accepted" with retryOfFailure=true: no state changed, so an
//   identical retry may run again.
// - begin() with a key already 'running' returns "in_progress" so concurrent
//   duplicates never double-execute.
// - begin() with a previously used key but a DIFFERENT command checksum is a
//   conflict and always fails closed.
//
// The unique idempotency_key constraint is the concurrency boundary: two
// racing begins contend for one row, and the loser observes the winner's
// record. A raw actor label never persists — only a salted SHA-256
// fingerprint — so future token-derived identities cannot leak into history.
//
// The query capability is injected; this module never constructs a pool.

import { createHash } from "node:crypto"

import type pg from "pg"

import type { JsonValue } from "../contracts/index.js"
import { AppError } from "../core/index.js"

import { translatePoolError } from "./pool.js"

export type SchemaOperationStatus = "running" | "succeeded" | "failed"

export interface SchemaOperationRecord {
  readonly id: number
  readonly idempotencyKey: string
  readonly commandType: string
  readonly command: JsonValue
  readonly checksum: string
  readonly status: SchemaOperationStatus
  readonly actorFingerprint: string
  readonly errorCode: string | null
  readonly result: JsonValue | null
  readonly createdAt: Date
  readonly finishedAt: Date | null
}

export type SchemaOperationBeginOutcome =
  | {
      readonly kind: "accepted"
      readonly record: SchemaOperationRecord
      /** True when this accepted begin retries a previously failed record. */
      readonly retryOfFailure: boolean
    }
  | { readonly kind: "replay"; readonly record: SchemaOperationRecord }
  | { readonly kind: "in_progress"; readonly record: SchemaOperationRecord }

export interface SchemaOperationLogDependencies {
  query: (text: string, values?: unknown[]) => Promise<pg.QueryResult>
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 200
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const COMMAND_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
const MAX_ACTOR_LENGTH = 200
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,40}$/
const MAX_LIST_LIMIT = 500

const INSERT_SQL = `
  INSERT INTO microjbase.schema_operations
    (idempotency_key, command_type, command, checksum, status, actor_fingerprint)
  VALUES ($1, $2, $3::jsonb, $4, 'running', $5)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id, idempotency_key, command_type, command, checksum, status,
            actor_fingerprint, error_code, result, created_at, finished_at
`

const SELECT_BY_KEY_SQL = `
  SELECT id, idempotency_key, command_type, command, checksum, status,
         actor_fingerprint, error_code, result, created_at, finished_at
  FROM microjbase.schema_operations
  WHERE idempotency_key = $1
`

const RESTART_FAILED_SQL = `
  UPDATE microjbase.schema_operations
  SET status = 'running', error_code = NULL, finished_at = NULL
  WHERE id = $1 AND status = 'failed'
  RETURNING id, idempotency_key, command_type, command, checksum, status,
            actor_fingerprint, error_code, result, created_at, finished_at
`

const SUCCEED_SQL = `
  UPDATE microjbase.schema_operations
  SET status = 'succeeded', result = $2::jsonb, finished_at = now()
  WHERE id = $1 AND status = 'running'
  RETURNING id
`

const FAIL_SQL = `
  UPDATE microjbase.schema_operations
  SET status = 'failed', error_code = $2, finished_at = now()
  WHERE id = $1 AND status = 'running'
  RETURNING id
`

const LIST_SQL = `
  SELECT id, idempotency_key, command_type, command, checksum, status,
         actor_fingerprint, error_code, result, created_at, finished_at
  FROM microjbase.schema_operations
  ORDER BY id DESC
  LIMIT $1 OFFSET $2
`

const SELECT_BY_ID_SQL = `
  SELECT id, idempotency_key, command_type, command, checksum, status,
         actor_fingerprint, error_code, result, created_at, finished_at
  FROM microjbase.schema_operations
  WHERE id = $1
`

// Canonical JSON with recursively sorted object keys and no whitespace, so a
// command checksum is stable regardless of key insertion order.
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  const keys = Object.keys(value).sort()
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
  )
  return `{${members.join(",")}}`
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

export function computeOperationChecksum(
  commandType: string,
  command: JsonValue,
): string {
  return sha256Hex(`v1|${commandType}|${canonicalJson(command)}`)
}

export function computeActorFingerprint(actor: string): string {
  return sha256Hex(`v1|actor|${actor.trim().toLowerCase()}`)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) {
      deepFreeze(member)
    }
    Object.freeze(value)
  }
  return value
}

function malformedRecord(reason: string): AppError {
  return new AppError(
    "INTERNAL_ERROR",
    `Malformed schema operation record: ${reason}`,
    500,
  )
}

interface OperationRow {
  id: unknown
  idempotency_key: unknown
  command_type: unknown
  command: unknown
  checksum: unknown
  status: unknown
  actor_fingerprint: unknown
  error_code: unknown
  result: unknown
  created_at: unknown
  finished_at: unknown
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformedRecord(`${field} must be a non-empty string`)
  }
  return value
}

function mapOperationRow(row: OperationRow): SchemaOperationRecord {
  const status = requireString(row.status, "status")
  if (status !== "running" && status !== "succeeded" && status !== "failed") {
    throw malformedRecord(`status "${status}" is unknown`)
  }
  // The pg driver delivers int8 (BIGSERIAL) as a decimal string because
  // JavaScript numbers cannot hold every int8; accept both shapes strictly.
  const id =
    typeof row.id === "number"
      ? row.id
      : typeof row.id === "string" && /^[0-9]+$/.test(row.id)
        ? Number(row.id)
        : null
  if (id === null || !Number.isSafeInteger(id)) {
    throw malformedRecord("id must be an integer")
  }
  const command = row.command
  if (
    command === null ||
    typeof command !== "object" ||
    Array.isArray(command)
  ) {
    throw malformedRecord("command must be a JSON object")
  }
  const result = row.result
  if (
    result !== null &&
    (typeof result !== "object" || Array.isArray(result))
  ) {
    // Result may be any JSON value; arrays and primitives are acceptable.
    if (
      typeof result !== "string" &&
      typeof result !== "number" &&
      typeof result !== "boolean"
    ) {
      throw malformedRecord("result must be JSON or null")
    }
  }
  if (!(row.created_at instanceof Date)) {
    throw malformedRecord("created_at must be a timestamp")
  }
  if (row.finished_at !== null && !(row.finished_at instanceof Date)) {
    throw malformedRecord("finished_at must be a timestamp or null")
  }
  return deepFreeze({
    id,
    idempotencyKey: requireString(row.idempotency_key, "idempotency_key"),
    commandType: requireString(row.command_type, "command_type"),
    command: command as JsonValue,
    checksum: requireString(row.checksum, "checksum"),
    status,
    actorFingerprint: requireString(row.actor_fingerprint, "actor_fingerprint"),
    errorCode: typeof row.error_code === "string" ? row.error_code : null,
    result: result as JsonValue | null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  })
}

function validateIdempotencyKey(idempotencyKey: string): void {
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "idempotencyKey must start with an alphanumeric character and contain only letters, digits, '.', '_' or '-'",
      400,
    )
  }
}

function validateCommandType(commandType: string): void {
  if (!COMMAND_TYPE_PATTERN.test(commandType)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "commandType must match the typed command naming pattern",
      400,
    )
  }
}

function validateCommand(command: JsonValue): void {
  if (
    command === null ||
    typeof command !== "object" ||
    Array.isArray(command)
  ) {
    throw new AppError("VALIDATION_ERROR", "command must be a JSON object", 400)
  }
}

function validateActor(actor: string): void {
  if (actor.trim().length === 0 || actor.length > MAX_ACTOR_LENGTH) {
    throw new AppError(
      "VALIDATION_ERROR",
      "actor must be a non-empty string",
      400,
    )
  }
}

export interface BeginOperationInput {
  idempotencyKey: string
  commandType: string
  command: JsonValue
  actor: string
}

export interface ListOperationsInput {
  limit?: number
  offset?: number
}

export interface SchemaOperationLog {
  begin(input: BeginOperationInput): Promise<SchemaOperationBeginOutcome>
  succeed(id: number, result: JsonValue): Promise<SchemaOperationRecord>
  fail(id: number, errorCode: string): Promise<SchemaOperationRecord>
  get(idempotencyKey: string): Promise<SchemaOperationRecord | null>
  list(input?: ListOperationsInput): Promise<readonly SchemaOperationRecord[]>
}

export function createSchemaOperationLog(
  deps: SchemaOperationLogDependencies,
): SchemaOperationLog {
  async function queryRow(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult> {
    try {
      return await deps.query(text, values)
    } catch (error: unknown) {
      throw translatePoolError(error)
    }
  }

  async function get(
    idempotencyKey: string,
  ): Promise<SchemaOperationRecord | null> {
    validateIdempotencyKey(idempotencyKey)
    const result = await queryRow(SELECT_BY_KEY_SQL, [idempotencyKey])
    const row = result.rows[0] as OperationRow | undefined
    if (row === undefined) {
      return null
    }
    return mapOperationRow(row)
  }

  // Applies the replay/conflict semantics to an existing record. Retries of
  // failed records reset them to 'running'; concurrent retries race on the
  // status='failed' guard and the loser re-reads and re-applies.
  async function classifyExisting(
    record: SchemaOperationRecord,
    checksum: string,
  ): Promise<SchemaOperationBeginOutcome> {
    if (record.checksum !== checksum) {
      throw new AppError(
        "CONFLICT",
        "Idempotency key was already used with a different operation",
        409,
        { idempotencyKey: record.idempotencyKey },
      )
    }
    if (record.status === "succeeded") {
      return { kind: "replay", record }
    }
    if (record.status === "running") {
      return { kind: "in_progress", record }
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const restartResult = await queryRow(RESTART_FAILED_SQL, [record.id])
      const restarted = restartResult.rows[0] as OperationRow | undefined
      if (restarted !== undefined) {
        return {
          kind: "accepted",
          record: mapOperationRow(restarted),
          retryOfFailure: true,
        }
      }
      const latest = await get(record.idempotencyKey)
      if (latest === null) {
        throw malformedRecord("record disappeared during retry")
      }
      if (latest.status === "succeeded") {
        return { kind: "replay", record: latest }
      }
      if (latest.status === "running") {
        return { kind: "in_progress", record: latest }
      }
    }
    throw new AppError(
      "CONFLICT",
      "Operation retry is already being claimed by another caller",
      409,
      { idempotencyKey: record.idempotencyKey },
    )
  }

  return {
    async begin(
      input: BeginOperationInput,
    ): Promise<SchemaOperationBeginOutcome> {
      validateIdempotencyKey(input.idempotencyKey)
      validateCommandType(input.commandType)
      validateCommand(input.command)
      validateActor(input.actor)

      const checksum = computeOperationChecksum(
        input.commandType,
        input.command,
      )
      const actorFingerprint = computeActorFingerprint(input.actor)

      const insertedResult = await queryRow(INSERT_SQL, [
        input.idempotencyKey,
        input.commandType,
        JSON.stringify(input.command),
        checksum,
        actorFingerprint,
      ])
      const inserted = insertedResult.rows[0] as OperationRow | undefined
      if (inserted !== undefined) {
        return {
          kind: "accepted",
          record: mapOperationRow(inserted),
          retryOfFailure: false,
        }
      }

      const existing = await get(input.idempotencyKey)
      if (existing === null) {
        throw malformedRecord("insert conflicted but no record is visible")
      }
      return classifyExisting(existing, checksum)
    },

    async succeed(
      id: number,
      result: JsonValue,
    ): Promise<SchemaOperationRecord> {
      const resultJson = JSON.stringify(result)
      const outcome = await queryRow(SUCCEED_SQL, [id, resultJson])
      if (outcome.rows.length === 0) {
        throw malformedRecord(`operation ${String(id)} is not running`)
      }
      const record = await getById(id)
      return record
    },

    async fail(id: number, errorCode: string): Promise<SchemaOperationRecord> {
      if (!ERROR_CODE_PATTERN.test(errorCode)) {
        throw new AppError(
          "VALIDATION_ERROR",
          "errorCode must be a stable uppercase error code",
          400,
        )
      }
      const outcome = await queryRow(FAIL_SQL, [id, errorCode])
      if (outcome.rows.length === 0) {
        throw malformedRecord(`operation ${String(id)} is not running`)
      }
      return getById(id)
    },

    async get(idempotencyKey: string): Promise<SchemaOperationRecord | null> {
      return get(idempotencyKey)
    },

    async list(
      input: ListOperationsInput = {},
    ): Promise<readonly SchemaOperationRecord[]> {
      const limit =
        input.limit === undefined
          ? 50
          : Math.min(Math.floor(input.limit), MAX_LIST_LIMIT)
      const offset = input.offset === undefined ? 0 : Math.floor(input.offset)
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError(
          "VALIDATION_ERROR",
          "limit must be a positive integer",
          400,
        )
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          "offset must be a non-negative integer",
          400,
        )
      }
      const result = await queryRow(LIST_SQL, [limit, offset])
      return result.rows.map((row) => mapOperationRow(row as OperationRow))
    },
  }

  async function getById(id: number): Promise<SchemaOperationRecord> {
    const result = await queryRow(SELECT_BY_ID_SQL, [id])
    const row = result.rows[0] as OperationRow | undefined
    if (row === undefined) {
      throw malformedRecord(`operation ${String(id)} is missing`)
    }
    return mapOperationRow(row)
  }
}
