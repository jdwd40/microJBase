// Domain errors for the auth module.
//
// Core's AppError class is not on master yet (open PR #15). Auth must not
// import from core; this local class implements the frozen contracts AppError
// interface so HTTP can map code/status/message/details later.

import type { AppError, ErrorCode } from "../contracts/index.js"

export class AuthError extends Error implements AppError {
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
    this.name = "AuthError"
    this.code = code
    this.status = status
    if (details !== undefined) {
      this.details = details
    }
  }
}

export function isAppErrorLike(
  error: unknown,
): error is AppError & { code: ErrorCode } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  )
}
