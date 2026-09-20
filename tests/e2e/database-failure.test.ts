// E2E database-unavailable acceptance: a deterministic, non-flaky proof that
// /health and normal requests expose only the safe 503 DATABASE_UNAVAILABLE
// envelope when PostgreSQL rejects new connections for the dedicated E2E
// runtime role.
//
// The kill switch changes ONLY the dedicated microjbase_e2e_runtime role
// (never the integration suite's role): new connections fail authentication
// (SQLSTATE 28P01, explicitly mapped to 503), and existing pooled sessions
// are terminated. Polling an eventual state avoids arbitrary sleeps.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ensureRuntimeRole, withClient } from "./helpers/database.js"
import { expectError, registerUser } from "./helpers/http.js"
import {
  startE2EFile,
  stopE2EFile,
  type E2EContext,
} from "./helpers/lifecycle.js"
import { adminMaintenanceUrl } from "./helpers/config.js"

const BLOCKED_PASSWORD = "e2e_blocked_not_the_real_password"

async function terminateRuntimeSessions(): Promise<void> {
  await withClient(adminMaintenanceUrl(), async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE usename = 'microjbase_e2e_runtime' AND pid <> pg_backend_pid()`,
    )
  })
}

async function blockRuntimeRole(): Promise<void> {
  await withClient(adminMaintenanceUrl(), async (client) => {
    // Order matters: make NEW connections fail first, then kill the pooled
    // sessions so no cached connection can serve requests.
    await client.query(
      `ALTER ROLE microjbase_e2e_runtime PASSWORD '${BLOCKED_PASSWORD}';`,
    )
  })
  await terminateRuntimeSessions()
}

async function pollHealth(
  ctx: E2EContext,
  predicate: (status: number, code: string | null) => boolean,
  timeoutMs = 15_000,
): Promise<{ status: number; code: string | null }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await ctx.api.get("/health")
      const code =
        (response.body as { error: { code: string } | null })?.error?.code ??
        null
      if (predicate(response.status, code)) {
        return { status: response.status, code }
      }
    } catch {
      // Server not reachable yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `health did not reach the expected state within ${timeoutMs}ms\n` +
      ctx.server.output(),
  )
}

describe("e2e database unavailability", () => {
  let ctx: E2EContext
  let token: string

  beforeAll(async () => {
    ctx = await startE2EFile()
    ;({ token } = await registerUser(ctx.api, `mia-${ctx.run}@example.test`))
  })

  afterAll(async () => {
    await stopE2EFile(ctx)
  })

  it("reports 503 DATABASE_UNAVAILABLE and recovers cleanly", async () => {
    // Healthy baseline.
    const healthy = await pollHealth(ctx, (status) => status === 200)
    expect(healthy.code).toBeNull()

    try {
      await blockRuntimeRole()

      // Eventual-state polling, not timing-based.
      const down = await pollHealth(
        ctx,
        (status, code) => status === 503 && code === "DATABASE_UNAVAILABLE",
      )
      expect(down.code).toBe("DATABASE_UNAVAILABLE")

      // A normal authenticated request exposes only the safe error.
      const data = await ctx.api.get("/v1/data/todos", token)
      expectError(data, 503, "DATABASE_UNAVAILABLE")
      for (const forbidden of [
        "28P01",
        "FATAL",
        BLOCKED_PASSWORD,
        "password authentication failed",
        "microjbase_e2e_runtime",
      ]) {
        expect(data.text).not.toContain(forbidden)
      }
    } finally {
      // Self-healing restore; also repairs state if the test failed midway.
      await ensureRuntimeRole()
      await terminateRuntimeSessions()
    }

    // Recovery: health returns to 200 and requests succeed again.
    await pollHealth(ctx, (status) => status === 200)
    const recovered = await ctx.api.get("/v1/data/todos", token)
    expect(recovered.status).toBe(200)
  })
})
