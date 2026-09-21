// E2E malformed and oversized request acceptance against the real network
// server: malformed JSON, bodies over the 1 MiB default limit, and wrong
// body shapes must produce the exact public status/code/envelope.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { expectError, registerUser } from "./helpers/http.js"
import {
  startE2EFile,
  stopE2EFile,
  type E2EContext,
} from "./helpers/lifecycle.js"

const MAX_BODY_BYTES = 1_048_576 // production default

describe("e2e malformed and oversized requests", () => {
  let ctx: E2EContext
  let token: string

  beforeAll(async () => {
    ctx = await startE2EFile()
    ;({ token } = await registerUser(ctx.api, `kate-${ctx.run}@example.test`))
  })

  afterAll(async () => {
    await stopE2EFile(ctx)
  })

  it("returns 400 VALIDATION_ERROR for malformed JSON", async () => {
    const response = await ctx.api.send("POST", "/v1/data/todos", "{not json", {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    })

    expectError(response, 400, "VALIDATION_ERROR")
    expect(response.headers.get("x-request-id")).toBeTruthy()
  })

  it("returns 413 VALIDATION_ERROR for a body over the 1 MiB default", async () => {
    const oversized = `"${"x".repeat(MAX_BODY_BYTES)}"` // MAX_BODY_BYTES + 2 bytes
    expect(Buffer.byteLength(oversized)).toBe(MAX_BODY_BYTES + 2)

    const response = await ctx.api.send("POST", "/v1/data/todos", oversized, {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    })

    expectError(response, 413, "VALIDATION_ERROR")
    const body = response.body as { error: { message: string } }
    expect(body.error.message).toMatch(/too large/i)
  })

  it("rejects scalar, array, and null JSON bodies with 400", async () => {
    for (const raw of ['"just a string"', "[1, 2, 3]", "null"]) {
      const response = await ctx.api.send("POST", "/v1/data/todos", raw, {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      })
      expectError(response, 400, "VALIDATION_ERROR")
    }
  })

  it("rejects unknown fields on auth endpoints with 400", async () => {
    const response = await ctx.api.post("/v1/auth/register", {
      email: `leo-${ctx.run}@example.test`,
      password: "correct horse battery staple",
      role: "admin",
    })

    expectError(response, 400, "VALIDATION_ERROR")
  })
})
