import { describe, expect, it } from "vitest"

import type {
  AppError as AppErrorContract,
  ErrorCode,
} from "../../../src/contracts/index.js"
import {
  AppError,
  isAppError,
  toPublicError,
} from "../../../src/core/errors.js"

class AuthError extends Error implements AppErrorContract {
  public override readonly name = "AuthError"
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
    this.code = code
    this.status = status
    if (details !== undefined) {
      this.details = details
    }
  }
}

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

  it("does not expose undefined details", () => {
    const error = new AppError("VALIDATION_ERROR", "Invalid input", 400)
    expect(error.details).toBeUndefined()
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

  it("recognises a foreign AppError-shaped error", () => {
    const foreign = new AuthError(
      "INVALID_CREDENTIALS",
      "Invalid email or password",
      401,
      { field: "password" },
    )
    const converted = toPublicError(foreign)

    expect(converted.code).toBe("INVALID_CREDENTIALS")
    expect(converted.status).toBe(401)
    expect(converted.message).toBe("Invalid email or password")
    expect(converted.details).toEqual({ field: "password" })
  })

  it("does not propagate stack or cause from a foreign error", () => {
    const foreign = new AuthError(
      "AUTH_REQUIRED",
      "Authentication required",
      401,
    )
    const converted = toPublicError(foreign)

    const json = converted.toJSON()
    expect(json).not.toHaveProperty("stack")
    expect(json).not.toHaveProperty("cause")
  })

  it("rejects an unknown code from a shaped object", () => {
    const bad = {
      code: "NOT_A_REAL_CODE",
      message: "oops",
      status: 400,
    }
    const converted = toPublicError(bad)

    expect(converted.code).toBe("INTERNAL_ERROR")
    expect(converted.status).toBe(500)
  })

  it("rejects a success status from a shaped object", () => {
    const bad = {
      code: "AUTH_REQUIRED",
      message: "oops",
      status: 200,
    }
    const converted = toPublicError(bad)

    expect(converted.code).toBe("INTERNAL_ERROR")
    expect(converted.status).toBe(500)
  })

  it("rejects a client error status below 400 from a shaped object", () => {
    const bad = {
      code: "VALIDATION_ERROR",
      message: "oops",
      status: 399,
    }
    const converted = toPublicError(bad)

    expect(converted.code).toBe("INTERNAL_ERROR")
    expect(converted.status).toBe(500)
  })

  it("rejects an unsafe status from a shaped object", () => {
    const bad = {
      code: "VALIDATION_ERROR",
      message: "oops",
      status: 999,
    }
    const converted = toPublicError(bad)

    expect(converted.code).toBe("INTERNAL_ERROR")
    expect(converted.status).toBe(500)
  })

  it("rejects non-record details from a shaped object", () => {
    const bad = {
      code: "VALIDATION_ERROR",
      message: "oops",
      status: 400,
      details: "leak",
    }
    const converted = toPublicError(bad)

    expect(converted.code).toBe("INTERNAL_ERROR")
    expect(converted.status).toBe(500)
  })

  it("rejects array details from a shaped object", () => {
    const bad = {
      code: "VALIDATION_ERROR",
      message: "oops",
      status: 400,
      details: ["leak"],
    }
    const converted = toPublicError(bad)

    expect(converted.code).toBe("INTERNAL_ERROR")
    expect(converted.status).toBe(500)
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

  it("returns true for foreign AppError-shaped errors", () => {
    expect(
      isAppError(
        new AuthError("AUTH_REQUIRED", "Authentication required", 401),
      ),
    ).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isAppError(new Error("plain"))).toBe(false)
    expect(isAppError(null)).toBe(false)
  })

  it("returns false for objects with invalid code", () => {
    expect(isAppError({ code: "NOPE", message: "x", status: 400 })).toBe(false)
  })

  it("returns false for objects with success status", () => {
    expect(
      isAppError({ code: "AUTH_REQUIRED", message: "x", status: 200 }),
    ).toBe(false)
  })

  it("returns false for objects with array details", () => {
    expect(
      isAppError({
        code: "VALIDATION_ERROR",
        message: "x",
        status: 400,
        details: ["leak"],
      }),
    ).toBe(false)
  })

  it("returns false for objects with non-plain object details", () => {
    class Custom {}
    expect(
      isAppError({
        code: "VALIDATION_ERROR",
        message: "x",
        status: 400,
        details: new Custom(),
      }),
    ).toBe(false)
  })
})
