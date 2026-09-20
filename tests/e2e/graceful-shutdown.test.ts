// E2E graceful shutdown: a real process-level proof that SIGTERM stops the
// compiled server cleanly, closes its database pool, refuses new requests,
// and can be restarted.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { E2E_RUNTIME_ROLE, adminMaintenanceUrl } from "./helpers/config.js"
import {
  dropDatabase,
  provisionDatabase,
  withClient,
} from "./helpers/database.js"
import {
  spawnServer,
  waitForHealth,
  type RunningServer,
} from "./helpers/server.js"

async function countRuntimeSessions(): Promise<number> {
  return withClient(adminMaintenanceUrl(), async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_stat_activity
       WHERE usename = '${E2E_RUNTIME_ROLE}'`,
    )
    return Number(result.rows[0]?.count ?? "0")
  })
}

describe("e2e graceful shutdown", () => {
  let dedicated: RunningServer | undefined

  beforeAll(async () => {
    await provisionDatabase()
  })

  afterAll(async () => {
    await dedicated?.stop().catch(() => undefined)
    await dropDatabase().catch(() => undefined)
  })

  it("shuts down cleanly on SIGTERM, closes the pool, and restarts", async () => {
    dedicated = await spawnServer()
    try {
      await waitForHealth(dedicated)
      expect(await countRuntimeSessions()).toBeGreaterThan(0)

      await dedicated.stop()
      expect(dedicated.process.exitCode).toBe(0)

      // The server stops accepting requests after exit.
      await expect(fetch(dedicated.baseUrl + "/health")).rejects.toThrow()

      // The database pool closed: no runtime sessions remain.
      await expect
        .poll(() => countRuntimeSessions(), { timeout: 10_000, interval: 250 })
        .toBe(0)

      // A fresh process against the same database starts cleanly.
      const restarted = await spawnServer()
      try {
        await waitForHealth(restarted)
      } finally {
        await restarted.stop()
        expect(restarted.process.exitCode).toBe(0)
      }
    } finally {
      await dedicated.stop().catch(() => undefined)
    }
  })
})
