import { describe, expect, it } from "vitest"

import {
  AppError,
  isAppError,
  toPublicError,
} from "../../../src/core/errors.js"

describe("AppError", () => {
  it("captures code, message, status and details", () => {
    const error = new AppError("VALIDATION_ERROR", "Invalid input", 400, {
      field: "email",
    })

    expect(error.name).toBe("AppError")
    expect(error.code).toBe("VALIDATION_ERROR")
    expect(error.message).toBe("Invalid input")
    expect(error.status).toBe(400)
    expect(error.details).toEqual({ field: "email" })
  })
})

describe("toPublicError", () => {
  it("returns the same AppError", () => {
    const original = new AppError(
      "AUTH_REQUIRED",
      "Authentication required",
      401,
    )
    const converted = toPublicError(original)

    expect(converted).toBe(original)
  })

  it("wraps generic errors as INTERNAL_ERROR", () => {
    const converted = toPublicError(new Error("database exploded"))

    expect(converted.code).toBe("INTERNAL_ERROR")
    expect(converted.status).toBe(500)
    expect(converted.message).toBe("An unexpected error occurred")
  })

  it("wraps non-error values as INTERNAL_ERROR", () => {
    const converted = toPublicError("something went wrong")

    expect(converted.code).toBe("INTERNAL_ERROR")
    expect(converted.status).toBe(500)
  })
})

describe("isAppError", () => {
  it("returns true for AppError instances", () => {
    expect(isAppError(new AppError("CONFLICT", "Conflict", 409))).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isAppError(new Error("plain"))).toBe(false)
    expect(isAppError(null)).toBe(false)
  })
})
