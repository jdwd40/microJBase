// Frozen shared contracts for microJBase v0.1 (see CONTRACTS.md).
// Architect-owned: proposed changes require the CONTRACTS.md change process.

export * from "./auth.js"
export * from "./data.js"

// Domain errors have a stable machine code and safe public message.
// Unexpected errors become INTERNAL_ERROR; stack traces and database
// messages are logged server-side with redaction but never returned.
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
  | "INTERNAL_ERROR"

export interface AppError {
  code: ErrorCode
  message: string
  status: number
  details?: Record<string, unknown>
}
