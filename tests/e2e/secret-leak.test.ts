// E2E secret-leakage acceptance: drive representative success and failure
// traffic — including the database-unavailable window — and assert the
// compiled server's own stdout/stderr contains no password, raw token,
// token hash, password hash, database URL, or database password.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { adminMaintenanceUrl, runtimeDatabaseUrl } from "./helpers/config.js"
import {
  adminQuery,
  ensureRuntimeRole,
  withClient,
} from "./helpers/database.js"
import { expectError, postOversizedJson, registerUser } from "./helpers/http.js"
import {
  startE2EFile,
  stopE2EFile,
  type E2EContext,
} from "./helpers/lifecycle.js"

describe("e2e secret leakage", () => {
  let ctx: E2EContext

  beforeAll(async () => {
    ctx = await startE2EFile()
  })

  afterAll(async () => {
    await stopE2EFile(ctx)
  })

  it("leaks no secrets to application logs across representative traffic", async () => {
    const password = `Sup3r!Sentinel-${ctx.run}`
    const email = `nora-${ctx.run}@example.test`

    // --- Register and capture the raw token as a sentinel. ---
    const { token, userId } = await registerUser(ctx.api, email, password)
    // Read the actual stored hashes while this user still has exactly one session.
    const stored = await adminQuery<{
      password_hash: string
      token_hash: Buffer
    }>(
      `SELECT u.password_hash, s.token_hash FROM microjbase.users u
       JOIN microjbase.sessions s ON s.user_id = u.id WHERE u.id = $1`,
      [userId],
    )
    expect(stored.rows).toHaveLength(1)
    const { password_hash, token_hash } = stored.rows[0]!

    // --- Successful login and failed login. ---
    const login = await ctx.api.post("/v1/auth/login", { email, password })
    expect(login.status).toBe(200)
    const failed = await ctx.api.post("/v1/auth/login", {
      email,
      password: `Wrong-${ctx.run}`,
    })
    expectError(failed, 401, "INVALID_CREDENTIALS")

    // --- /me and CRUD with the bearer token. ---
    const me = await ctx.api.get("/v1/auth/me", token)
    expect(me.status).toBe(200)
    const created = await ctx.api.post(
      "/v1/data/todos",
      { title: "secret canary" },
      token,
    )
    expect(created.status).toBe(201)
    const rowId = (created.body as { data: { id: string } }).data.id
    await ctx.api.get(`/v1/data/todos/${rowId}`, token)
    await ctx.api.patch(`/v1/data/todos/${rowId}`, { completed: true }, token)
    await ctx.api.del(`/v1/data/todos/${rowId}`, token)

    // --- Malformed and oversized input. ---
    await ctx.api.send("POST", "/v1/data/todos", "{not json", {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    })
    expectError(
      await postOversizedJson(ctx.api, token),
      413,
      "VALIDATION_ERROR",
    )

    // --- Database-unavailable window (pool errors included). ---
    await withClient(adminMaintenanceUrl(), async (client) => {
      await client.query(
        "ALTER ROLE microjbase_e2e_runtime PASSWORD 'e2e_blocked_temporarily';",
      )
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE usename = 'microjbase_e2e_runtime' AND pid <> pg_backend_pid()`,
      )
    })
    try {
      const deadline = Date.now() + 15_000
      let down = false
      while (Date.now() < deadline && !down) {
        try {
          const health = await ctx.api.get("/health")
          down =
            health.status === 503 &&
            (health.body as { error: { code: string } | null })?.error?.code ===
              "DATABASE_UNAVAILABLE"
        } catch {
          // keep polling
        }
        if (!down) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      expect(down).toBe(true)
    } finally {
      await ensureRuntimeRole()
      await withClient(adminMaintenanceUrl(), async (client) => {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE usename = 'microjbase_e2e_runtime' AND pid <> pg_backend_pid()`,
        )
      })
    }
    // Back to healthy for a clean shutdown.
    const deadline = Date.now() + 15_000
    let healthy = false
    while (Date.now() < deadline && !healthy) {
      const health = await ctx.api.get("/health")
      healthy = health.status === 200
      if (!healthy) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    expect(healthy).toBe(true)

    // --- Logout last. ---
    const logout = await ctx.api.post("/v1/auth/logout", {}, token)
    expect(logout.status).toBe(204)

    // --- Collect the remaining sentinels. ---
    const adminUrl = new URL(adminMaintenanceUrl())
    const postgresPort = adminUrl.port === "" ? 5432 : Number(adminUrl.port)
    const sentinels = {
      password,
      token,
      "stored session hash (hex)": token_hash.toString("hex"),
      "stored session hash (base64)": token_hash.toString("base64"),
      "stored password hash": password_hash,
      "database password": "microjbase_e2e_runtime_password",
      "database URL": runtimeDatabaseUrl(postgresPort),
    }
    const output = ctx.server.output()
    for (const [name, sentinel] of Object.entries(sentinels)) {
      expect(sentinel.length, name).toBeGreaterThan(0)
      expect(output.includes(sentinel), `application logged ${name}`).toBe(
        false,
      )
    }
  })
})
