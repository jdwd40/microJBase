import { describe, expect, it, beforeAll, afterAll } from "vitest"
import pg from "pg"

import { createPool, type Pool } from "../../../src/database/pool.js"

const databaseUrl =
  process.env.INTEGRATION_DATABASE_URL ??
  "postgres://microjbase_runtime:microjbase_runtime_password@127.0.0.1:5432/microjbase_dev"

describe("database pool", () => {
  let pool: Pool

  beforeAll(() => {
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
      databaseUrl: "postgres://microjbase:wrong@127.0.0.1:5432/microjbase_dev",
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

    // With a single-connection pool, a second concurrent connect must wait
    // (or time out). We expect it to still be pending when we inspect.
    let secondClient: pg.PoolClient | undefined
    const pending = localPool.connect().then((c) => {
      secondClient = c
    })

    // Give the pool a tick to enqueue the request.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(secondClient).toBeUndefined()

    holder.release()
    await pending
    secondClient?.release()
    await localPool.close()
  })
})
