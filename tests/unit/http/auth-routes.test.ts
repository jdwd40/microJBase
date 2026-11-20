import type { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AuthError } from "../../../src/auth/index.js"
import { buildServer } from "../../../src/http/index.js"
import { serviceSpies } from "./service-spies.js"

const credentials = {
  email: "alice@example.com",
  password: "correct horse battery staple",
}
const user = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: credentials.email,
  createdAt: new Date("2026-01-01T00:00:00Z"),
}
const token = Buffer.alloc(32, 7).toString("base64url")
const result = { user, token, expiresAt: new Date("2026-01-01T01:00:00Z") }
const authRequired = new AuthError(
  "AUTH_REQUIRED",
  "Authentication required",
  401,
)

describe("auth routes", () => {
  let app: FastifyInstance
  let services: ReturnType<typeof serviceSpies>
  beforeEach(async () => {
    services = serviceSpies()
    app = await buildServer(services, { disableRequestLogging: true })
  })
  afterEach(async () => {
    await app.close()
  })

  it.each([
    ["register", 201],
    ["login", 200],
  ] as const)(
    "%s returns the public session envelope, request ID and no-store",
    async (operation, status) => {
      services.authService[operation].mockResolvedValue(result)
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/" + operation,
        payload: credentials,
      })
      expect(services.authService[operation]).toHaveBeenCalledExactlyOnceWith(
        credentials,
      )
      expect(response.statusCode).toBe(status)
      expect(response.json()).toEqual({
        error: null,
        data: {
          token,
          expires_at: result.expiresAt.toISOString(),
          user: {
            id: user.id,
            email: user.email,
            created_at: user.createdAt.toISOString(),
          },
        },
      })
      expect(response.headers["cache-control"]).toBe("no-store")
      expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/)
    },
  )

  it("rejects extra registration fields before calling auth and sets no-store", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { ...credentials, extra: "field" },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("VALIDATION_ERROR")
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(services.authService.register).not.toHaveBeenCalled()
  })

  it("passes a bearer to logout and returns a bodyless 204 with no-store", async () => {
    services.authService.logout.mockResolvedValue(undefined)
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(services.authService.logout).toHaveBeenCalledExactlyOnceWith(token)
    expect(response.statusCode).toBe(204)
    expect(response.body).toBe("")
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it("maps malformed logout tokens and invalid /me sessions to a no-store 401", async () => {
    services.authService.logout.mockRejectedValue(authRequired)
    services.authService.authenticate.mockRejectedValue(authRequired)
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: "Bearer not-a-token" },
    })
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(services.authService.logout).toHaveBeenCalledExactlyOnceWith(
      "not-a-token",
    )
    expect(services.authService.authenticate).toHaveBeenCalledExactlyOnceWith(
      token,
    )
    for (const [route, response] of [
      ["logout", logout],
      ["me", me],
    ] as const) {
      expect(response.statusCode, route).toBe(401)
      expect(response.json().error.code, route).toBe("AUTH_REQUIRED")
      expect(response.headers["cache-control"], route).toBe("no-store")
    }
  })

  it("rejects missing, wrong-scheme and empty bearer headers before authenticating", async () => {
    for (const authorization of [undefined, "Basic token", "Bearer"]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: authorization ? { authorization } : {},
      })
      expect(response.statusCode, String(authorization)).toBe(401)
      expect(response.headers["cache-control"], String(authorization)).toBe(
        "no-store",
      )
    }
    expect(services.authService.authenticate).not.toHaveBeenCalled()
  })

  it("rejects the eleventh failed login with Retry-After and no-store", async () => {
    services.authService.login.mockRejectedValue(
      new AuthError("INVALID_CREDENTIALS", "Invalid email or password", 401),
    )
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: credentials,
      })
    for (let i = 0; i < 10; i++)
      expect((await attempt()).statusCode, `attempt ${i + 1}`).toBe(401)
    const blocked = await attempt()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().error.code).toBe("RATE_LIMITED")
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/)
    expect(blocked.headers["cache-control"]).toBe("no-store")
    expect(services.authService.login).toHaveBeenCalledTimes(10)
  })
})
