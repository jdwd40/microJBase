// Stable application errors for microJBase v0.1.
//
// Domain errors have machine-readable codes and safe public messages.
// Unexpected errors are wrapped as INTERNAL_ERROR; transport and database
// details are never exposed to clients.

import type {
  AppError as AppErrorContract,
  ErrorCode,
} from "../contracts/index.js"

export type { ErrorCode }

export class AppError extends Error implements AppErrorContract {
  public readonly code: ErrorCode
  public readonly status: number
  public readonly details?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AppError"
    this.code = code
    this.status = status
    if (details !== undefined) {
      this.details = details
    }
  }

  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      code: this.code,
      message: this.message,
      status: this.status,
    }
    if (this.details !== undefined) {
      result.details = this.details
    }
    return result
  }
}

const ERROR_CODES: readonly string[] = [
  "VALIDATION_ERROR",
  "EMAIL_ALREADY_REGISTERED",
  "INVALID_CREDENTIALS",
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "TABLE_NOT_FOUND",
  "ROW_NOT_FOUND",
  "CONFLICT",
  "DATABASE_UNAVAILABLE",
  "INTERNAL_ERROR",
]

const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === "string" && ERROR_CODES.includes(value)

const isSafeStatus = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 100 &&
  value <= 599

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (typeof key !== "string") {
      return false
    }
  }
  return true
}

const looksLikeAppError = (error: unknown): error is AppErrorContract => {
  if (typeof error !== "object" || error === null) {
    return false
  }

  const candidate = error as Record<string, unknown>

  if (!isErrorCode(candidate["code"])) {
    return false
  }
  if (typeof candidate["message"] !== "string") {
    return false
  }
  if (!isSafeStatus(candidate["status"])) {
    return false
  }

  const details = candidate["details"]
  if (details !== undefined && !isRecord(details)) {
    return false
  }

  return true
}

export function toPublicError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error
  }

  if (looksLikeAppError(error)) {
    return new AppError(error.code, error.message, error.status, error.details)
  }

  return new AppError("INTERNAL_ERROR", "An unexpected error occurred", 500)
}

export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) {
    return true
  }

  return looksLikeAppError(error)
}
