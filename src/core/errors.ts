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
  public readonly details?: Record<string, unknown> | undefined

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown> | undefined,
  ) {
    super(message)
    this.name = "AppError"
    this.code = code
    this.status = status
    this.details = details
  }
}

export function toPublicError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error
  }

  if (error instanceof Error) {
    return new AppError("INTERNAL_ERROR", "An unexpected error occurred", 500)
  }

  return new AppError("INTERNAL_ERROR", "An unexpected error occurred", 500)
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
