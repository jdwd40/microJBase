import { describe, expect, it } from "vitest"

import { translatePoolError } from "../../../src/database/pool.js"

describe("translatePoolError", () => {
  it("classifies PostgreSQL connection SQLSTATE 08 as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(new Error("connection failed"), {
      code: "08006",
    })
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies ECONNREFUSED as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      {
        code: "ECONNREFUSED",
      },
    )
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies ENOTFOUND as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(
      new Error("getaddrinfo ENOTFOUND internal-db.example"),
      {
        code: "ENOTFOUND",
      },
    )
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies EAI_AGAIN as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(
      new Error("getaddrinfo EAI_AGAIN internal-db.example"),
      {
        code: "EAI_AGAIN",
      },
    )
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies ETIMEDOUT as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    })
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies EHOSTUNREACH as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(new Error("connect EHOSTUNREACH"), {
      code: "EHOSTUNREACH",
    })
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies ENETUNREACH as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(new Error("connect ENETUNREACH"), {
      code: "ENETUNREACH",
    })
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies EPIPE as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies ECONNRESET as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    })
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies PostgreSQL startup failure 57P01 as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(
      new Error("terminating connection due to administrator command"),
      {
        code: "57P01",
      },
    )
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies too many connections 53300 as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(new Error("sorry, too many clients already"), {
      code: "53300",
    })
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database is unavailable")
  })

  it("classifies authentication failure 28P01 as DATABASE_UNAVAILABLE", () => {
    const error = Object.assign(
      new Error('password authentication failed for user "runtime"'),
      {
        code: "28P01",
      },
    )
    const result = translatePoolError(error, { databaseUrlForErrors: "***" })
    expect(result.code).toBe("DATABASE_UNAVAILABLE")
    expect(result.message).toBe("Database authentication failed")
  })

  it("does not include database URL topology in the public message", () => {
    const error = Object.assign(
      new Error("connect ECONNREFUSED internal-db.example:5432"),
      {
        code: "ECONNREFUSED",
      },
    )
    const result = translatePoolError(error, {
      databaseUrlForErrors:
        "postgres://runtime_user:***@internal-db.example:5432/production_db",
    })
    expect(result.message).not.toContain("internal-db.example")
    expect(result.message).not.toContain("runtime_user")
    expect(result.message).not.toContain("5432")
    expect(result.message).not.toContain("production_db")
  })
})
