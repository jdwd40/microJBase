import { describe, expect, it } from "vitest"
import { translatePoolError } from "../../../src/database/pool.js"

describe("translatePoolError", () => {
  it.each([
    ["08006", "connection failed"],
    [
      "ECONNREFUSED",
      "connect ECONNREFUSED postgres://runtime_user:secret@internal-db.example:5432/production_db",
    ],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND internal-db.example"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN internal-db.example"],
    ["ETIMEDOUT", "connect ETIMEDOUT"],
    ["EHOSTUNREACH", "connect EHOSTUNREACH"],
    ["ENETUNREACH", "connect ENETUNREACH"],
    ["EPIPE", "write EPIPE"],
    ["ECONNRESET", "read ECONNRESET"],
    ["57P01", "terminating connection due to administrator command"],
    ["53300", "sorry, too many clients already"],
  ])(
    "maps %s to the generic 503 without connection details",
    (code, message) => {
      const failure = Object.assign(new Error(message), { code })
      expect(translatePoolError(failure).toJSON()).toEqual({
        code: "DATABASE_UNAVAILABLE",
        status: 503,
        message: "Database is unavailable",
      })
    },
  )

  it("maps database authentication failure to a redacted 503", () => {
    const failure = Object.assign(
      new Error('password authentication failed for user "runtime"'),
      { code: "28P01" },
    )
    expect(translatePoolError(failure).toJSON()).toEqual({
      code: "DATABASE_UNAVAILABLE",
      status: 503,
      message: "Database authentication failed",
    })
  })
})
