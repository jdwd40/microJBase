import type { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Pool } from "../../../src/database/index.js"
import { buildServer } from "../../../src/http/index.js"
import { serviceSpies } from "./service-spies.js"

describe("HTTP error handling", () => {
  let app: FastifyInstance
  const query = vi.fn<() => Promise<never>>()
  beforeEach(async () => {
    query.mockReset()
    const pool: Pool = {
      query,
      connect: vi.fn<Pool["connect"]>(),
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    }
    app = await buildServer(
      { ...serviceSpies(), pool },
      { disableRequestLogging: true },
    )
  })
  afterEach(async () => {
    await app.close()
  })

  it.each([
    [
      "connection refused",
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      }),
      503,
      "DATABASE_UNAVAILABLE",
    ],
    [
      "unexpected failure",
      new Error("unexpected non-database failure"),
      500,
      "INTERNAL_ERROR",
    ],
  ] as const)(
    "health translates %s and redacts the underlying error",
    async (_label, failure, status, code) => {
      query.mockRejectedValue(failure)
      const response = await app.inject({ method: "GET", url: "/health" })
      expect(query).toHaveBeenCalledOnce()
      expect(response.statusCode).toBe(status)
      expect(response.json()).toMatchObject({ data: null, error: { code } })
      expect(response.body).not.toContain(failure.message)
    },
  )

  it.each([
    ["malformed JSON", "{not json", 400],
    ["empty JSON", "", 400],
    [
      "oversized JSON",
      JSON.stringify({
        email: "a@example.com",
        password: "x".repeat(2_000_000),
      }),
      413,
    ],
  ] as const)(
    "rejects %s on login with a no-store validation response",
    async (_case, payload, status) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: { "content-type": "application/json" },
        payload,
      })
      expect(response.statusCode).toBe(status)
      expect(response.json()).toMatchObject({
        data: null,
        error: { code: "VALIDATION_ERROR" },
      })
      expect(response.headers["cache-control"]).toBe("no-store")
    },
  )

  it("sanitises an unmapped Fastify content-type error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "email=a@example.com&password=secretsecret",
    })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({
      data: null,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    })
    expect(response.body).not.toContain("Unsupported Media")
  })

  it("leaves the cache-control header unset on non-auth JSON parse failures", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/data/items",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer testtoken",
      },
      payload: "{not json",
    })
    expect(response.statusCode).toBe(400)
    expect(response.headers["cache-control"]).toBeUndefined()
  })

  it("returns the public 404 envelope for an unregistered route", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/unknown" })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      data: null,
      error: { code: "TABLE_NOT_FOUND" },
    })
  })
})
