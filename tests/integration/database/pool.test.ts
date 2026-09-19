import { describe, expect, it, beforeAll, afterAll } from "vitest"
import pg from "pg"

import { createPool, type Pool } from "../../../src/database/pool.js"
import { applyMigrationsAndGrants, withClient } from "./bootstrap.js"

const databaseUrl = process.env.INTEGRATION_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "INTEGRATION_DATABASE_URL environment variable is required for integration tests",
  )
}

const adminDatabaseUrl = process.env.INTEGRATION_ADMIN_DATABASE_URL
if (!adminDatabaseUrl) {
  throw new Error(
    "INTEGRATION_ADMIN_DATABASE_URL environment variable is required for pool tests",
  )
}

const RUNTIME_ROLE_NAME = "microjbase_runtime"

describe("database pool", () => {
  let pool: Pool

  beforeAll(async () => {
    await applyMigrationsAndGrants(adminDatabaseUrl, RUNTIME_ROLE_NAME)
    pool = createPool({ databaseUrl, maxConnections: 2 })
  })

  afterAll(async () => {
    await pool.close()
  })

  it("runs a simple query", async () => {
    const result = await pool.query<{ one: number }>("SELECT 1 AS one")
    expect(result.rows).toEqual([{ one: 1 }])
  })

  it("checks out a client that can be released back to the pool", async () => {
    const client = await pool.connect()
    const result = await client.query<{ two: number }>("SELECT 2 AS two")
    expect(result.rows).toEqual([{ two: 2 }])
    client.release()
  })

  it("reuses connections across sequential checkouts", async () => {
    const client1 = await pool.connect()
    const backend1 = (
      await client1.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid
    client1.release()

    const client2 = await pool.connect()
    const backend2 = (
      await client2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid
    client2.release()

    expect(backend1).toBe(backend2)
  })

  it("closes cleanly and rejects further queries", async () => {
    const localPool = createPool({ databaseUrl, maxConnections: 1 })
    await localPool.close()
    await expect(localPool.query("SELECT 1")).rejects.toThrow(
      "Database pool has already been closed",
    )
  })

  it("surfaces connection errors as DATABASE_UNAVAILABLE", async () => {
    const badPool = createPool({
      databaseUrl: "postgres://microjbase:***@127.0.0.1:1/microjbase_dev",
      maxConnections: 1,
    })
    await expect(badPool.query("SELECT 1")).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
    })
    await badPool.close()
  })

  it("respects maxConnections by bounding the pool", async () => {
    const localPool = createPool({ databaseUrl, maxConnections: 1 })
    const holder = await localPool.connect()

    let secondClient: pg.PoolClient | undefined
    const pending = localPool.connect().then((c) => {
      secondClient = c
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(secondClient).toBeUndefined()

    holder.release()
    await pending
    secondClient?.release()
    await localPool.close()
  })

  it("does not include database URL topology in public connection errors", async () => {
    const badPool = createPool({
      databaseUrl: "postgres://runtime_user:***@127.0.0.1:1/production_db",
      maxConnections: 1,
    })
    try {
      await badPool.query("SELECT 1")
    } catch (error: unknown) {
      expect(error).toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message: "Database is unavailable",
      })
      const text = JSON.stringify(error)
      expect(text).not.toContain("127.0.0.1")
      expect(text).not.toContain("runtime_user")
      expect(text).not.toContain("production_db")
    }
    await badPool.close()
  })

  it("does not include raw error messages in pool error logs", async () => {
    const logs: string[] = []
    const logger = {
      error: (msg: string) => logs.push(msg),
      warn: () => {},
      info: () => {},
      debug: () => {},
    }
    const badPool = createPool({
      databaseUrl: "postgres://runtime_user:***@127.0.0.1:1/dbname",
      maxConnections: 1,
      logger,
    })
    await expect(badPool.query("SELECT 1")).rejects.toBeDefined()

    for (const log of logs) {
      expect(log).not.toContain("runtime_user")
      expect(log).not.toMatch(/password authentication failed|ECONNREFUSED/)
    }
    await badPool.close()
  })

  it("does not emit connection metadata when an idle pool client is terminated", async () => {
    const logs: string[] = []
    const logger = {
      error: (msg: string) => logs.push(msg),
      warn: () => {},
      info: () => {},
      debug: () => {},
    }
    const localPool = createPool({
      databaseUrl,
      maxConnections: 1,
      logger,
    })

    const client = await localPool.connect()
    const backendPid = (
      await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid
    client.release()

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`SELECT pg_terminate_backend(${backendPid ?? 0})`)
    })

    // Give the pool time to receive the error event from the terminated idle client.
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(logs.length).toBeGreaterThan(0)
    for (const log of logs) {
      expect(log).not.toContain(databaseUrl)
      expect(log).not.toMatch(
        /microjbase_runtime|127\.0\.0\.1|543[0-9]|microjbase/,
      )
      expect(log).not.toMatch(/password|terminat|backend|connection|\bpid\b/i)
    }

    // The pool must remain usable: the terminated client is evicted and a fresh
    // client is created for the next checkout.
    const result = await localPool.query<{ one: number }>("SELECT 1 AS one")
    expect(result.rows).toEqual([{ one: 1 }])

    await localPool.close()
  })
})
