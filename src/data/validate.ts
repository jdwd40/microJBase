// Input validation helpers for the data domain service.

import type { DataRow, JsonValue } from "../contracts/index.js"

import { DataError } from "./errors.js"

/** Canonical UUID: lowercase hex only (api-spec path/id rules). */
export const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const DEFAULT_LIMIT = 50
export const DEFAULT_OFFSET = 0
export const MIN_LIMIT = 1
export const MAX_LIMIT = 100
export const MIN_OFFSET = 0
export const MAX_OFFSET = 100_000

export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID.test(value)
}

export function requireCanonicalUuid(
  value: string,
  field: string = "id",
): string {
  if (!isCanonicalUuid(value)) {
    throw new DataError("VALIDATION_ERROR", "Request validation failed", 400, {
      [field]: "Must be a canonical UUID",
    })
  }
  return value
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

export function resolveLimit(limit: unknown): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT
  }
  if (!isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw new DataError("VALIDATION_ERROR", "Request validation failed", 400, {
      limit: `Must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    })
  }
  return limit
}

export function resolveOffset(offset: unknown): number {
  if (offset === undefined) {
    return DEFAULT_OFFSET
  }
  if (!isInteger(offset) || offset < MIN_OFFSET || offset > MAX_OFFSET) {
    throw new DataError("VALIDATION_ERROR", "Request validation failed", 400, {
      offset: `Must be an integer between ${MIN_OFFSET} and ${MAX_OFFSET}`,
    })
  }
  return offset
}

/**
 * True for a plain JSON object (not null, array, or other exotic object).
 * Accepts `Object.prototype` and null-prototype objects.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function throwBodyValidationError(): never {
  throw new DataError("VALIDATION_ERROR", "Request validation failed", 400, {
    body: "Must be a non-empty JSON object",
  })
}

function throwJsonValidationError(): never {
  throw new DataError("VALIDATION_ERROR", "Request validation failed", 400, {
    body: "Must contain JSON-compatible values only",
  })
}

/**
 * Iterative JSON-value check matching the frozen `JsonValue` contract and
 * `docs/database-spec.md` (no Date/Buffer/bigint/NaN/Infinity across the port).
 * Avoids unbounded recursive call stacks on deep trees; rejects cycles.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  const stack: unknown[] = [value]
  const seen = new WeakSet<object>()

  while (stack.length > 0) {
    const current = stack.pop()
    // length > 0, so undefined here is a stored property value — not JSON.
    if (current === undefined) {
      return false
    }

    if (current === null) {
      continue
    }

    const type = typeof current
    if (type === "string" || type === "boolean") {
      continue
    }
    if (type === "number") {
      if (!Number.isFinite(current)) {
        return false
      }
      continue
    }
    if (type !== "object") {
      // undefined, function, symbol, bigint
      return false
    }

    if (seen.has(current)) {
      return false
    }
    seen.add(current)

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(current, i)) {
          // Array hole — not representable as JSON.
          return false
        }
        stack.push(current[i])
      }
      continue
    }

    if (Buffer.isBuffer(current) || current instanceof Date) {
      return false
    }

    if (!isPlainObject(current)) {
      return false
    }

    for (const key of Object.keys(current)) {
      stack.push(current[key])
    }
  }

  return true
}

export function requireNonEmptyPlainObject(
  values: unknown,
): Record<string, unknown> {
  if (!isPlainObject(values)) {
    throwBodyValidationError()
  }
  const keys = Object.keys(values)
  if (keys.length === 0) {
    throwBodyValidationError()
  }
  return values
}

/**
 * Top-level non-empty plain object whose entire value tree is `JsonValue`.
 */
export function requireJsonDataRow(values: unknown): DataRow {
  const object = requireNonEmptyPlainObject(values)
  if (!isJsonValue(object)) {
    throwJsonValidationError()
  }
  return object
}

export function assertKeysAllowed(
  values: Record<string, unknown>,
  allowed: readonly string[],
  kind: "insertable" | "updatable",
): void {
  const allowedSet = new Set(allowed)
  const invalidEntries: [string, string][] = []
  for (const key of Object.keys(values)) {
    if (!allowedSet.has(key)) {
      invalidEntries.push([
        key,
        kind === "insertable"
          ? "Column is not insertable"
          : "Column is not updatable",
      ])
    }
  }
  if (invalidEntries.length > 0) {
    // Object.fromEntries uses CreateDataProperty — safe for `__proto__`.
    throw new DataError(
      "VALIDATION_ERROR",
      "Request validation failed",
      400,
      Object.fromEntries(invalidEntries),
    )
  }
}
