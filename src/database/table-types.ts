// Shared PostgreSQL type/conversion metadata for the table registry and data repository.
//
// This is a private database-adapter implementation detail; it does not appear
// in the frozen public contracts.

import { AppError } from "../core/index.js"

export type JsonPrimitive = string | number | boolean | null
export type JsonObject = { [key: string]: JsonValue }
export type JsonArray = JsonValue[]
export type JsonValue = JsonPrimitive | JsonObject | JsonArray

export type TypeConverter = (value: unknown) => JsonValue

function asString(value: unknown): string {
  if (value === null) return ""
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (value === null) return false
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") return value.toLowerCase() === "true"
  return Boolean(value)
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppError(
        "CONFLICT",
        "Database value cannot be represented as a finite number",
        409,
      )
    }
    return value
  }
  if (value === null) return 0
  if (typeof value === "string") {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      throw new AppError(
        "CONFLICT",
        "Database value cannot be represented as a finite number",
        409,
      )
    }
    return parsed
  }
  throw new AppError(
    "CONFLICT",
    "Database value cannot be represented as a finite number",
    409,
  )
}

function asIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") return value
  if (value === null) return ""
  return String(value)
}

function asJson(value: unknown): JsonValue {
  if (value === null) return null
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as JsonValue
  }
  if (typeof value === "object") {
    if (Buffer.isBuffer(value) || value instanceof Date) {
      throw new AppError(
        "CONFLICT",
        "Database value cannot be represented as JSON",
        409,
      )
    }
    if (Array.isArray(value)) {
      return value.map((item) => asJson(item))
    }
    const result: JsonObject = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = asJson(val)
    }
    return result
  }
  throw new AppError(
    "CONFLICT",
    "Database value cannot be represented as JSON",
    409,
  )
}

export const SUPPORTED_TYPES = new Map<string, TypeConverter>([
  ["uuid", asString],
  ["text", asString],
  ["varchar", asString],
  ["character varying", asString],
  ["char", asString],
  ["character", asString],
  ["boolean", asBoolean],
  ["bool", asBoolean],
  ["smallint", asNumber],
  ["integer", asNumber],
  ["int", asNumber],
  ["int4", asNumber],
  ["real", asNumber],
  ["float4", asNumber],
  ["double precision", asNumber],
  ["float8", asNumber],
  ["bigint", asString],
  ["int8", asString],
  ["numeric", asString],
  ["decimal", asString],
  ["date", asIsoString],
  ["timestamp without time zone", asIsoString],
  ["timestamp", asIsoString],
  ["timestamp with time zone", asIsoString],
  ["timestamptz", asIsoString],
  ["json", asJson],
  ["jsonb", asJson],
])

export interface ColumnMetadata {
  name: string
  dataType: string
  isNullable: boolean
  isGenerated: boolean
  isIdentity: boolean
  hasDefault: boolean
  hasSelect: boolean
  hasInsert: boolean
  hasUpdate: boolean
}

export interface VerifiedTableMetadata {
  alias: string
  schema: string
  table: string
  primaryKey: "id"
  readableColumns: readonly string[]
  insertableColumns: readonly string[]
  updatableColumns: readonly string[]
  columnTypes: { readonly [column: string]: string }
}

export function normalizeType(typeName: string): string {
  const lower = typeName.toLowerCase().trim()
  if (lower === "character varying") return "varchar"
  if (lower === "timestamp without time zone") return "timestamp"
  if (lower === "timestamp with time zone") return "timestamptz"
  return lower
}

export function isSupportedType(typeName: string): boolean {
  return SUPPORTED_TYPES.has(normalizeType(typeName))
}
