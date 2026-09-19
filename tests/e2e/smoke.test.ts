import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"

import { buildServer } from "../../src/main.js"

// Placeholder smoke test proving the server responds over HTTP injection.
// Real end-to-end tests start the compiled server against a clean database
// in the e2e PR.
describe("toolchain smoke (e2e)", () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = buildServer()
  })

  afterEach(async () => {
    await app.close()
  })

  it("serves the health envelope", async () => {
    const response = await app.inject({ method: "GET", url: "/health" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      data: { status: "ok" },
      error: null,
    })
  })
})
