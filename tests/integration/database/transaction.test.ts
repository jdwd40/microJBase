import { describe, expect, it, beforeAll, afterAll } from "vitest"

import {
  createPool,
  createTransactionRunner,
  type Pool,
  type TransactionRunner,
} from "../../../src/database/index.js"
import { applyMigrationsAndGrants } from "./bootstrap.js"

const databaseUrl = process.env.INTEGRATION_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "INTEGRATION_DATABASE_URL environment variable is required for integration tests",
  )
}

const adminDatabaseUrl = process.env.INTEGRATION_ADMIN_DATABASE_URL
if (!adminDatabaseUrl) {
  throw new Error(
    "INTEGRATION_ADMIN_DATABASE_URL environment variable is required for transaction tests",
  )
}

const RUNTIME_ROLE_NAME = "microjbase_runtime"

describe("transaction helper", () => {
  let pool: Pool
  let runner: TransactionRunner

  beforeAll(async () => {
    await applyMigrationsAndGrants(adminDatabaseUrl, RUNTIME_ROLE_NAME)
    pool = createPool({ databaseUrl, maxConnections: 1 })
    runner = createTransactionRunner(() => pool.connect())
  })

  afterAll(async () => {
    await pool.close()
  })

  it("commits a successful block", async () => {
    const result = await runner.withTransaction(async (ctx) => {
      const rs = await ctx.query<{ one: number }>("SELECT 1 AS one")
      return rs.rows[0]?.one
    })
    expect(result).toBe(1)
  })

  it("rolls back on error", async () => {
    const tempTable = `temp_tx_test_${Date.now()}`
    await pool.query(`CREATE TEMP TABLE ${tempTable} (id int)`)

    await expect(
      runner.withTransaction(async (ctx) => {
        await ctx.query(`INSERT INTO ${tempTable} VALUES (1)`)
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    const result = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${tempTable}`,
    )
    expect(result.rows[0]?.count).toBe(0)
  })

  it("sets microjbase.user_id transaction-locally", async () => {
    const userId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
    const readBack = await runner.withTransaction(
      async (ctx) => {
        const rs = await ctx.query<{ value: string }>(
          "SELECT current_setting('microjbase.user_id', true) AS value",
        )
        return rs.rows[0]?.value
      },
      { userId },
    )
    expect(readBack).toBe(userId)
  })

  it("does not leak identity to the next borrower of the same connection", async () => {
    const userId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

    await runner.withTransaction(
      async () => {
        // identity set here
      },
      { userId },
    )

    const leaked = await runner.withTransaction(async (ctx) => {
      const rs = await ctx.query<{ value: string | null }>(
        "SELECT nullif(current_setting('microjbase.user_id', true), '') AS value",
      )
      return rs.rows[0]?.value
    })

    expect(leaked).toBeNull()
  })

  it("clears identity even after rollback", async () => {
    const userId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

    await expect(
      runner.withTransaction(
        async () => {
          throw new Error("deliberate")
        },
        { userId },
      ),
    ).rejects.toThrow("deliberate")

    const leaked = await runner.withTransaction(async (ctx) => {
      const rs = await ctx.query<{ value: string | null }>(
        "SELECT nullif(current_setting('microjbase.user_id', true), '') AS value",
      )
      return rs.rows[0]?.value
    })

    expect(leaked).toBeNull()
  })
})
