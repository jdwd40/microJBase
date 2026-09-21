// E2E auth acceptance: register/login/logout/me semantics, public error
// equivalence, bearer handling, and Cache-Control: no-store on every auth
// response — all over real HTTP against the compiled server.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { adminQuery } from "./helpers/database.js"
import {
  expectError,
  expectNoStore,
  publicError,
  registerUser,
  unknownToken,
} from "./helpers/http.js"
import {
  startE2EFile,
  stopE2EFile,
  type E2EContext,
} from "./helpers/lifecycle.js"

const PASSWORD = "correct horse battery staple"

describe("e2e auth acceptance", () => {
  let ctx: E2EContext
  let email: string

  beforeAll(async () => {
    ctx = await startE2EFile()
    email = `carol-${ctx.run}@example.test`
  })

  afterAll(async () => {
    await stopE2EFile(ctx)
  })

  it("registers a new user with a 201 envelope", async () => {
    const response = await ctx.api.post("/v1/auth/register", {
      email,
      password: PASSWORD,
    })

    expect(response.status).toBe(201)
    const body = response.body as {
      data: {
        user: { id: string; email: string; created_at: string }
        token: string
        expires_at: string
      }
      error: null
    }
    expect(body.error).toBeNull()
    expect(body.data.user.email).toBe(email)
    expect(body.data.user.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.data.user.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(body.data.token.length).toBeGreaterThan(20)
    expect(new Date(body.data.expires_at).getTime()).toBeGreaterThan(Date.now())
    expectNoStore(response)
    expect(response.headers.get("x-request-id")).toBeTruthy()
  })

  it("rejects duplicate registration with 409 EMAIL_ALREADY_REGISTERED", async () => {
    const response = await ctx.api.post("/v1/auth/register", {
      email,
      password: "a different password entirely",
    })

    expectError(response, 409, "EMAIL_ALREADY_REGISTERED")
    expectNoStore(response)
  })

  it("logs in successfully and rejects unknown auth fields with 400", async () => {
    const login = await ctx.api.post("/v1/auth/login", {
      email,
      password: PASSWORD,
    })
    expect(login.status).toBe(200)
    expect((login.body as { data: { token: string } }).data.token).toBeTruthy()
    expectNoStore(login)

    const extra = await ctx.api.post("/v1/auth/register", {
      email: `dave-${ctx.run}@example.test`,
      password: PASSWORD,
      admin: true,
    })
    expectError(extra, 400, "VALIDATION_ERROR")
    expectNoStore(extra)

    const missing = await ctx.api.post("/v1/auth/login", { email })
    expectError(missing, 400, "VALIDATION_ERROR")
  })

  it("treats wrong email and wrong password as publicly equivalent", async () => {
    const wrongEmail = await ctx.api.post("/v1/auth/login", {
      email: `nobody-${ctx.run}@example.test`,
      password: PASSWORD,
    })
    const wrongPassword = await ctx.api.post("/v1/auth/login", {
      email,
      password: "wrong password guess",
    })

    expectError(wrongEmail, 401, "INVALID_CREDENTIALS")
    expectError(wrongPassword, 401, "INVALID_CREDENTIALS")
    expect(publicError(wrongEmail)).toEqual(publicError(wrongPassword))
    expectNoStore(wrongEmail)
    expectNoStore(wrongPassword)
  })

  it("resolves the current user with /me", async () => {
    const { token, userId } = await registerUser(
      ctx.api,
      `erin-${ctx.run}@example.test`,
      PASSWORD,
    )

    const me = await ctx.api.get("/v1/auth/me", token)
    expect(me.status).toBe(200)
    expect(me.body).toEqual({
      data: { id: userId, email: `erin-${ctx.run}@example.test` },
      error: null,
    })
    expectNoStore(me)
  })

  it("revokes the session on logout and rejects the token afterwards", async () => {
    const { token } = await registerUser(
      ctx.api,
      `frank-${ctx.run}@example.test`,
      PASSWORD,
    )

    const logout = await ctx.api.post("/v1/auth/logout", {}, token)
    expect(logout.status).toBe(204)
    expect(logout.text).toBe("")
    expectNoStore(logout)

    const me = await ctx.api.get("/v1/auth/me", token)
    expectError(me, 401, "AUTH_REQUIRED")

    const data = await ctx.api.get("/v1/data/todos", token)
    expectError(data, 401, "AUTH_REQUIRED")
  })

  it("treats logout as idempotent and opaque for unknown tokens", async () => {
    const { token } = await registerUser(
      ctx.api,
      `grace-${ctx.run}@example.test`,
      PASSWORD,
    )

    const first = await ctx.api.post("/v1/auth/logout", {}, token)
    expect(first.status).toBe(204)

    // Already-revoked token: still 204.
    const second = await ctx.api.post("/v1/auth/logout", {}, token)
    expect(second.status).toBe(204)

    // Never-issued but well-shaped token: still 204, no existence signal.
    const unknown = await ctx.api.post("/v1/auth/logout", {}, unknownToken())
    expect(unknown.status).toBe(204)
  })

  it("rejects missing and malformed bearer headers with 401", async () => {
    const missing = await ctx.api.get("/v1/auth/me")
    expectError(missing, 401, "AUTH_REQUIRED")
    expectNoStore(missing)

    const basic = await ctx.api.send("GET", "/v1/auth/me", undefined, {
      authorization: "Basic dXNlcjpwYXNz",
    })
    expectError(basic, 401, "AUTH_REQUIRED")

    const emptyBearer = await ctx.api.send("GET", "/v1/auth/me", undefined, {
      authorization: "Bearer",
    })
    expectError(emptyBearer, 401, "AUTH_REQUIRED")

    const bareToken = await ctx.api.send("GET", "/v1/auth/me", undefined, {
      authorization: "not-a-bearer-token",
    })
    expectError(bareToken, 401, "AUTH_REQUIRED")
  })

  it("rejects a data route with no Authorization header and performs no write", async () => {
    const before = await adminQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM public.todos",
    )

    // No Authorization header at all — not an empty, malformed, or unknown one.
    const response = await ctx.api.send(
      "POST",
      "/v1/data/todos",
      JSON.stringify({ title: "unauthenticated write" }),
      { "content-type": "application/json" },
    )
    expectError(response, 401, "AUTH_REQUIRED")

    const after = await adminQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM public.todos",
    )
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
  })
})
