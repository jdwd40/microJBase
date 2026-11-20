import { describe, expect, it } from "vitest"
import { AuthError } from "../../../src/auth/index.js"
import {
  AppError,
  isAppError,
  toPublicError,
} from "../../../src/core/errors.js"

describe("public application errors", () => {
  it("preserves a local AppError instance and its public fields", () => {
    const error = new AppError("VALIDATION_ERROR", "Invalid input", 400, {
      field: "email",
    })
    expect(error.name).toBe("AppError")
    expect(isAppError(error)).toBe(true)
    expect(toPublicError(error)).toBe(error)
    expect(error.toJSON()).toEqual({
      code: "VALIDATION_ERROR",
      message: "Invalid input",
      status: 400,
      details: { field: "email" },
    })
  })

  it("omits optional details when none were supplied", () => {
    const error = new AppError("AUTH_REQUIRED", "Authentication required", 401)
    expect(error.details).toBeUndefined()
    expect(error.toJSON()).toEqual({
      code: "AUTH_REQUIRED",
      message: "Authentication required",
      status: 401,
    })
  })

  it.each([undefined, { field: "password" }])(
    "converts a domain error with details %j, exposing only public fields",
    (details) => {
      const error = Object.assign(
        new AuthError(
          "INVALID_CREDENTIALS",
          "Invalid email or password",
          401,
          details,
        ),
        { cause: new Error("private cause") },
      )
      expect(isAppError(error)).toBe(true)
      expect(toPublicError(error).toJSON()).toEqual({
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password",
        status: 401,
        ...(details === undefined ? {} : { details }),
      })
    },
  )

  const shaped = {
    code: "VALIDATION_ERROR",
    message: "private detail",
    status: 400,
  }
  it.each([
    ["unknown code", { ...shaped, code: "NOPE" }],
    ["success status", { ...shaped, status: 200 }],
    ["below the error range", { ...shaped, status: 399 }],
    ["above the error range", { ...shaped, status: 999 }],
    ["string details", { ...shaped, details: "leak" }],
    ["array details", { ...shaped, details: ["leak"] }],
    ["custom prototype in details", { ...shaped, details: new Date(0) }],
    ["generic error", new Error("database exploded")],
    ["string", "something went wrong"],
    ["null", null],
  ] as const)(
    "rejects %s and returns the generic public envelope",
    (_case, input) => {
      expect(isAppError(input)).toBe(false)
      expect(toPublicError(input).toJSON()).toEqual({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "An unexpected error occurred",
      })
    },
  )
})
