// Domain errors for the data module.
//
// Data must not import from core; this local class implements the frozen
// contracts AppError interface so HTTP can map code/status/message/details later.

import type { AppError, ErrorCode } from "../contracts/index.js"

export class DataError extends Error implements AppError {
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
    this.name = "DataError"
    this.code = code
    this.status = status
    if (details !== undefined) {
      this.details = details
    }
  }
}
