import { describe, expect, it } from "vitest"

import { mapAuthResult, mapUser } from "../../../src/http/responses.js"

describe("response mapping", () => {
  it("maps auth result to snake_case", () => {
    const user = {
      id: "user-id",
      email: "alice@example.com",
      createdAt: new Date("2026-09-20T10:00:00.000Z"),
    }
    const result = mapAuthResult({
      user,
      token: "opaque-token",
      expiresAt: new Date("2026-09-27T10:00:00.000Z"),
    })

    expect(result).toEqual({
      user: {
        id: "user-id",
        email: "alice@example.com",
        created_at: "2026-09-20T10:00:00.000Z",
      },
      token: "opaque-token",
      expires_at: "2026-09-27T10:00:00.000Z",
    })
  })

  it("maps authenticated user without created_at", () => {
    const user = { id: "user-id", email: "alice@example.com" }
    expect(mapUser(user)).toEqual({
      id: "user-id",
      email: "alice@example.com",
    })
  })
})
