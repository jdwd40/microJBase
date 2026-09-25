// Shared guard and validation helpers for the opt-in admin API (V02-16).
//
// Every /v1/admin route is behind the same two gates, in order:
//
//  1. a dedicated in-memory rate limiter instance (separate from the auth
//     limiter, so admin traffic is never coupled to login/register limits);
//  2. operator-token authentication (D-013): SHA-256 digest comparison in
//     constant time against the configured MICROJBASE_ADMIN_TOKEN_SHA256.
//
// Ordinary session tokens are hashed and compared like any other candidate
// and never verify, so unauthenticated callers and ordinary sessions never
// reach the route handlers. The raw operator token is never logged or echoed.
//
// The helpers here also centralise the strict typed-command body validation
// shared by the mutation endpoints (V02-18): unknown fields are rejected,
// field types are checked, and snake_case JSON is mapped onto the camelCase
// internal command shapes. HTTP handlers never construct SQL.

import type { FastifyReply, FastifyRequest } from "fastify"

import { verifyOperatorToken } from "../auth/index.js"
import type { JsonPrimitive } from "../contracts/index.js"
import {
  type DdlColumnDefault,
  type DdlColumnType,
  type Pool,
  type SchemaConstraintService,
  type SchemaExposureService,
  type SchemaMutationService,
  type SchemaOperationLog,
  type SchemaOperationRecord,
  type SchemaPolicyService,
  type SchemaRlsService,
} from "../database/index.js"
import type { SchemaSnapshotReader } from "../contracts/index.js"
import { AppError } from "../core/index.js"

import { extractBearerToken } from "./bearer.js"
import { getPlainObjectBody } from "./helpers.js"
import type { InMemoryRateLimiter } from "./rate-limiter.js"
import { sendAppError } from "./responses.js"

/** Composed admin-lane surface wired by the composition root. */
export interface AdminDependencies {
  /** Decoded 32-byte SHA-256 digest of the single operator token (D-013). */
  tokenDigest: Buffer
  /** Bounded schema-admin pool; used by the capability probe. */
  pool: Pool
  snapshot: SchemaSnapshotReader
  history: Pick<SchemaOperationLog, "list">
  mutation: SchemaMutationService
  constraints: SchemaConstraintService
  exposure: SchemaExposureService
  rls: SchemaRlsService
  policies: SchemaPolicyService
  rateLimiter: InMemoryRateLimiter
}

/**
 * Rate-limit and authenticate an admin request. Returns an already-sent
 * error reply when the request is rejected, or null when the handler may
 * proceed. `endpoint` scopes the rate-limit key per admin endpoint.
 */
export function rejectUnlessAdminOperator(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AdminDependencies,
  endpoint: string,
): FastifyReply | null {
  const limit = deps.rateLimiter.check(`admin:${endpoint}:${request.ip}`)
  if (!limit.allowed) {
    return sendAppError(
      reply.header("Retry-After", String(limit.retryAfterSeconds)),
      new AppError("RATE_LIMITED", "Rate limit exceeded", 429),
    )
  }

  const token = extractBearerToken(request.headers.authorization)
  if (token === null) {
    return sendAppError(
      reply,
      new AppError("AUTH_REQUIRED", "Authentication required", 401),
    )
  }
  if (!verifyOperatorToken(token, deps.tokenDigest)) {
    return sendAppError(
      reply,
      new AppError("INVALID_CREDENTIALS", "Invalid operator token", 401),
    )
  }
  return null
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/**
 * Read and validate the required Idempotency-Key header (V02-18). Every
 * mutating admin command is protected by an operator-supplied key; without
 * one there is no idempotency boundary, so the request is refused.
 */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      idempotency_key:
        "Required header must match " + IDEMPOTENCY_KEY_PATTERN.source,
    })
  }
  return value
}

/** The recorded actor for HTTP-originated commands: one operator token (D-013) is one operator identity. */
export const HTTP_OPERATOR_ACTOR = "http-operator"

export function requirePlainBody(
  request: FastifyRequest,
): Record<string, unknown> {
  const body = getPlainObjectBody(request)
  if (body === null) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      body: "Must be a JSON object",
    })
  }
  return body
}

export function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(body).filter((key) => !allowedSet.has(key))
  if (unknown.length > 0) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      body: `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    })
  }
}

export function requireStringField(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be a non-empty string",
    })
  }
  return value
}

export function optionalStringField(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be a non-empty string",
    })
  }
  return value
}

export function requireBooleanField(
  body: Record<string, unknown>,
  field: string,
): boolean {
  const value = body[field]
  if (typeof value !== "boolean") {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be a boolean",
    })
  }
  return value
}

export function optionalBooleanField(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "boolean") {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be a boolean",
    })
  }
  return value
}

export function requireEnumField<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = body[field]
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: `Must be one of: ${allowed.join(", ")}`,
    })
  }
  return value as T
}

export function requireStringArrayField(
  body: Record<string, unknown>,
  field: string,
  bounds: { min: number; max: number },
): string[] {
  const value = body[field]
  if (!Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be an array of strings",
    })
  }
  if (value.length < bounds.min || value.length > bounds.max) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: `Must contain between ${bounds.min} and ${bounds.max} entries`,
    })
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
        [field]: "Must contain only non-empty strings",
      })
    }
  }
  return value as string[]
}

export const DDL_COLUMN_TYPES: readonly DdlColumnType[] = [
  "text",
  "integer",
  "bigint",
  "boolean",
  "uuid",
  "timestamp",
  "timestamptz",
  "date",
  "numeric",
  "jsonb",
]

export const FOREIGN_KEY_ACTIONS = [
  "no_action",
  "restrict",
  "cascade",
  "set_null",
] as const

export const OWNERSHIP_POLICY_TEMPLATES = [
  "read",
  "insert",
  "update",
  "delete",
] as const

export interface ColumnSpecInput {
  name: string
  type: DdlColumnType
  nullable: boolean
  default: DdlColumnDefault
}

/** Map a typed column spec from snake_case JSON to the internal command shape. */
export function mapColumnSpec(value: unknown, field: string): ColumnSpecInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be an object",
    })
  }
  const spec = value as Record<string, unknown>
  rejectUnknownFields(spec, ["name", "type", "nullable", "default"])
  return {
    name: requireStringField(spec, "name"),
    type: requireEnumField(spec, "type", DDL_COLUMN_TYPES),
    nullable: requireBooleanField(spec, "nullable"),
    default: mapColumnDefault(spec.default, `${field}.default`),
  }
}

const DEFAULT_KINDS = ["none", "literal", "current_timestamp", "random_uuid"]

/**
 * Map a column default from JSON. Only the frozen typed template model
 * exists — there is deliberately no arbitrary SQL default path (D-014).
 */
export function mapColumnDefault(
  value: unknown,
  field: string,
): DdlColumnDefault {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be an object",
    })
  }
  const spec = value as Record<string, unknown>
  rejectUnknownFields(spec, ["kind", "value"])
  const kind = requireEnumField(spec, "kind", DEFAULT_KINDS)
  switch (kind) {
    case "none":
    case "current_timestamp":
    case "random_uuid":
      return { kind }
    case "literal": {
      const literal = spec.value
      if (
        literal !== null &&
        typeof literal !== "string" &&
        typeof literal !== "number" &&
        typeof literal !== "boolean"
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Request validation failed",
          400,
          { [`${field}.value`]: "Must be a JSON primitive" },
        )
      }
      return { kind: "literal", value: literal as JsonPrimitive }
    }
    default:
      // requireEnumField guarantees one of the kinds above.
      throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
        [field]: "Must be a recognised default kind",
      })
  }
}

/** Common command tail for every mutation endpoint. */
export interface CommandBase {
  idempotencyKey: string
  actor: string
  dryRun?: boolean
}

export function commandBase(
  request: FastifyRequest,
  body: Record<string, unknown>,
): CommandBase {
  const base: CommandBase = {
    idempotencyKey: requireIdempotencyKey(request),
    actor: HTTP_OPERATOR_ACTOR,
  }
  const dryRun = optionalBooleanField(body, "dry_run")
  if (dryRun !== undefined) {
    base.dryRun = dryRun
  }
  return base
}

/** Map an operation record to the public snake_case shape. */
export function mapOperationRecord(
  record: SchemaOperationRecord,
): Record<string, unknown> {
  return {
    id: record.id,
    idempotency_key: record.idempotencyKey,
    command_type: record.commandType,
    command: record.command,
    checksum: record.checksum,
    status: record.status,
    actor_fingerprint: record.actorFingerprint,
    error_code: record.errorCode,
    result: record.result,
    created_at: record.createdAt.toISOString(),
    finished_at: record.finishedAt ? record.finishedAt.toISOString() : null,
  }
}
