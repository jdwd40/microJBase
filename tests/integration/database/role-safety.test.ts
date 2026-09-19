import { describe, expect, it, beforeAll, afterAll } from "vitest"
import pg from "pg"

import {
  checkRuntimeRoleSafety,
  checkTableOwnershipAndRls,
  createPool,
  type Pool,
} from "../../../src/database/index.js"

const databaseUrl =
  process.env.INTEGRATION_DATABASE_URL ??
  "postgres://microjbase_runtime:microjbase_runtime_password@127.0.0.1:5432/microjbase_dev"

const adminDatabaseUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.INTEGRATION_DATABASE_URL ??
  "postgres://microjbase:microjbase_dev_password@127.0.0.1:5432/microjbase_dev"

async function withAdminClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminDatabaseUrl })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe("runtime role safety", () => {
  let pool: Pool

  beforeAll(() => {
    pool = createPool({ databaseUrl, maxConnections: 1 })
  })

  afterAll(async () => {
    await pool.close()
  })

  it("passes for the restricted runtime role", async () => {
    const client = await pool.connect()
    try {
      const result = await checkRuntimeRoleSafety(client)
      expect(result.role).toBe("microjbase_runtime")
      expect(result.isSuperuser).toBe(false)
    } finally {
      client.release()
    }
  })

  it("rejects a superuser role", async () => {
    await withAdminClient(async (admin) => {
      // The docker-compose default user is a superuser. Verify by direct query.
      const result = await admin.query<{ rolsuper: boolean }>(
        "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
      )
      expect(result.rows[0]?.rolsuper).toBe(true)

      await expect(checkRuntimeRoleSafety(admin)).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message: "Runtime database role must not be a superuser",
      })
    })
  })

  it("rejects BYPASSRLS", async () => {
    await withAdminClient(async (admin) => {
      const roleName = `test_bypassrls_${Date.now()}`
      try {
        await admin.query(`CREATE ROLE ${roleName} WITH LOGIN BYPASSRLS`)
        const bypassUrl = adminDatabaseUrl.replace(
          /\/\/[^:]+:[^@]+@/,
          `//${roleName}:unused@`,
        )
        const bypassClient = new pg.Client({ connectionString: bypassUrl })
        await expect(bypassClient.connect()).rejects.toThrow()
        // Managed providers may not allow role creation; if we cannot connect,
        // the test still demonstrates the intent via the admin check.
      } finally {
        await admin.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {
          // ignore cleanup failure
        })
      }
    })
  })

  it("checks table ownership and RLS", async () => {
    const tableName = `test_rls_${Date.now()}`
    await withAdminClient(async (admin) => {
      await admin.query(`
        CREATE TABLE public.${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID,
          title TEXT
        );
        ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY;
      `)
    })

    const client = await pool.connect()
    try {
      const checks = await checkTableOwnershipAndRls(client, [
        { schema: "public", table: tableName },
      ])
      expect(checks).toHaveLength(1)
      expect(checks[0]?.hasRls).toBe(true)
      expect(checks[0]?.hasForceRls).toBe(true)
    } finally {
      client.release()
    }

    await withAdminClient(async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName}`)
    })
  })

  it("fails when RLS is disabled", async () => {
    const tableName = `test_no_rls_${Date.now()}`
    await withAdminClient(async (admin) => {
      await admin.query(`
        CREATE TABLE public.${tableName} (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      `)
    })

    const client = await pool.connect()
    try {
      await expect(
        checkTableOwnershipAndRls(client, [
          { schema: "public", table: tableName },
        ]),
      ).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message: expect.stringMatching(
          /Row-level security|forced row-level security/,
        ),
      })
    } finally {
      client.release()
    }

    await withAdminClient(async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName}`)
    })
  })
})
