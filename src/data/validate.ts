// Input validation helpers for the data domain service.

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
 * Nested values inside the object are not flattened; only the top-level
 * container shape is checked here.
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

export function requireNonEmptyPlainObject(
  values: unknown,
): Record<string, unknown> {
  if (!isPlainObject(values)) {
    throw new DataError("VALIDATION_ERROR", "Request validation failed", 400, {
      body: "Must be a non-empty JSON object",
    })
  }
  const keys = Object.keys(values)
  if (keys.length === 0) {
    throw new DataError("VALIDATION_ERROR", "Request validation failed", 400, {
      body: "Must be a non-empty JSON object",
    })
  }
  return values
}

export function assertKeysAllowed(
  values: Record<string, unknown>,
  allowed: readonly string[],
  kind: "insertable" | "updatable",
): void {
  const allowedSet = new Set(allowed)
  const details: Record<string, string> = {}
  for (const key of Object.keys(values)) {
    if (!allowedSet.has(key)) {
      details[key] =
        kind === "insertable"
          ? "Column is not insertable"
          : "Column is not updatable"
    }
  }
  if (Object.keys(details).length > 0) {
    throw new DataError(
      "VALIDATION_ERROR",
      "Request validation failed",
      400,
      details,
    )
  }
}
