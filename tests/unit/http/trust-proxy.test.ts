import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"

import type { AuthService } from "../../../src/contracts/index.js"
import type { DataService } from "../../../src/data/index.js"
import { AppError } from "../../../src/core/index.js"
import { buildServer } from "../../../src/http/index.js"

/**
 * Transport-focused stubs. Login always fails with INVALID_CREDENTIALS so
 * rate-limit accounting still runs per attempt without argon2 cost.
 */
const stubAuthService: AuthService = {
  register: async () => {
    throw new AppError("INTERNAL_ERROR", "not used", 500)
  },
  login: async () => {
    throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401)
  },
  authenticate: async () => {
    throw new AppError("AUTH_REQUIRED", "Authentication required", 401)
  },
  logout: async () => undefined,
}

const stubDataService: DataService = {
  list: async () => ({ items: [], limit: 50, offset: 0 }),
  get: async () => {
    throw new AppError("INTERNAL_ERROR", "not used", 500)
  },
  create: async () => {
    throw new AppError("INTERNAL_ERROR", "not used", 500)
  },
  update: async () => {
    throw new AppError("INTERNAL_ERROR", "not used", 500)
  },
  delete: async () => undefined,
}

const LOGIN_BODY = { email: "alice@example.com", password: "x" }
const XFF_HEADER = "x-forwarded-for"

async function hammerLogin(
  app: FastifyInstance,
  forwardedFor: string,
  attempts: number,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { [XFF_HEADER]: forwardedFor },
      payload: LOGIN_BODY,
    })
  }
}

describe("trust proxy behaviour for rate limiting", () => {
  let app: FastifyInstance

  afterEach(async () => {
    await app.close()
  })

  it("ignores attacker-supplied X-Forwarded-For when trustProxy is false", async () => {
    app = await buildServer(
      { authService: stubAuthService, dataService: stubDataService },
      { disableRequestLogging: true, trustProxy: false },
    )

    // Exhaust the limiter while pretending to come from 10.0.0.1.
    await hammerLogin(app, "10.0.0.1", 10)

    // A different spoofed IP must NOT get a fresh bucket: Fastify's
    // request.ip stays the socket address because trustProxy is false.
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { [XFF_HEADER]: "10.0.0.2" },
      payload: LOGIN_BODY,
    })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().error.code).toBe("RATE_LIMITED")
  })

  it("uses Fastify's resolved request.ip when trustProxy is true", async () => {
    app = await buildServer(
      { authService: stubAuthService, dataService: stubDataService },
      { disableRequestLogging: true, trustProxy: true },
    )

    // Exhaust the limiter for the proxied client 10.0.0.1.
    await hammerLogin(app, "10.0.0.1", 10)

    // Same proxied client stays blocked...
    const sameClient = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { [XFF_HEADER]: "10.0.0.1" },
      payload: LOGIN_BODY,
    })
    expect(sameClient.statusCode).toBe(429)
    expect(sameClient.json().error.code).toBe("RATE_LIMITED")

    // ...while a different proxied client has its own bucket and reaches the
    // auth service (401), proving request.ip drove the limiter key and the
    // application never parsed X-Forwarded-For itself.
    const otherClient = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { [XFF_HEADER]: "10.0.0.2" },
      payload: LOGIN_BODY,
    })
    expect(otherClient.statusCode).toBe(401)
    expect(otherClient.json().error.code).toBe("INVALID_CREDENTIALS")
  })
})
