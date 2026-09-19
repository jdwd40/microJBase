import { describe, expect, it, beforeAll, afterAll } from "vitest"
import pg from "pg"

import {
  checkApplicablePolicies,
  checkRuntimeRoleSafety,
  checkRuntimeTablePrivileges,
  checkTableOwnershipAndRls,
  createPool,
  type Pool,
} from "../../../src/database/index.js"
import {
  applyMigrationsAndGrants,
  cleanMigrations,
  withClient,
} from "./bootstrap.js"

const databaseUrl = process.env.INTEGRATION_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "INTEGRATION_DATABASE_URL environment variable is required for integration tests",
  )
}

const adminDatabaseUrl = process.env.INTEGRATION_ADMIN_DATABASE_URL
if (!adminDatabaseUrl) {
  throw new Error(
    "INTEGRATION_ADMIN_DATABASE_URL environment variable is required for role-safety tests",
  )
}

const RUNTIME_ROLE_NAME = "microjbase_runtime"

describe("runtime role safety", () => {
  let pool: Pool

  beforeAll(async () => {
    await cleanMigrations(adminDatabaseUrl)
    await applyMigrationsAndGrants(adminDatabaseUrl, RUNTIME_ROLE_NAME)
    pool = createPool({ databaseUrl, maxConnections: 1 })
  })

  afterAll(async () => {
    await pool.close()
  })

  it("passes for the restricted runtime role", async () => {
    const client = await pool.connect()
    try {
      const result = await checkRuntimeRoleSafety(client)
      expect(result.role).toBe(RUNTIME_ROLE_NAME)
      expect(result.isSuperuser).toBe(false)
      expect(result.hasBypassRls).toBe(false)
    } finally {
      client.release()
    }
  })

  it("rejects a superuser role", async () => {
    await withClient(adminDatabaseUrl, async (admin) => {
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

  it("rejects a connectable BYPASSRLS role", async () => {
    await withClient(adminDatabaseUrl, async (admin) => {
      const roleName = `test_bypassrls_${Date.now()}`
      const password = `bypass_password_${Date.now()}`
      try {
        await admin.query(
          `CREATE ROLE ${roleName} WITH LOGIN BYPASSRLS PASSWORD '${password}'`,
        )
        const bypassUrl = adminDatabaseUrl.replace(
          /\/\/[^:]+:[^@]+@/,
          `//${roleName}:${password}@`,
        )
        const bypassClient = new pg.Client({ connectionString: bypassUrl })
        await bypassClient.connect()
        try {
          await expect(
            checkRuntimeRoleSafety(bypassClient),
          ).rejects.toMatchObject({
            code: "DATABASE_UNAVAILABLE",
            message: "Runtime database role must not have BYPASSRLS",
          })
        } finally {
          await bypassClient.end()
        }
      } finally {
        await admin.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {
          // ignore cleanup failure
        })
      }
    })
  })

  it("checks table ownership and RLS", async () => {
    const tableName = `test_rls_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
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

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName}`)
    })
  })

  it("fails when RLS is disabled", async () => {
    const tableName = `test_no_rls_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
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

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName}`)
    })
  })

  it("rejects exposed tables with RLS enabled but forced RLS disabled", async () => {
    const tableName = `test_no_force_rls_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY;
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
        message: `Forced row-level security is not enabled on public.${tableName}`,
      })
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName}`)
    })
  })

  it("rejects exposed tables owned by the runtime role without forced RLS", async () => {
    const tableName = `test_runtime_owned_${Date.now()}`
    const runtimeClient = new pg.Client({ connectionString: databaseUrl })
    await runtimeClient.connect()
    try {
      await runtimeClient.query(`
        CREATE TABLE public.${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY;
      `)

      await expect(
        checkTableOwnershipAndRls(runtimeClient, [
          { schema: "public", table: tableName },
        ]),
      ).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message: `Forced row-level security is not enabled on public.${tableName}`,
      })
    } finally {
      await runtimeClient
        .query(`DROP TABLE IF EXISTS public.${tableName}`)
        .catch(() => {})
      await runtimeClient.end()
    }
  })

  it("verifies runtime grants on auth tables", async () => {
    const client = await pool.connect()
    try {
      const checks = await checkRuntimeTablePrivileges(client, [
        { schema: "microjbase", table: "users" },
        { schema: "microjbase", table: "sessions" },
        { schema: "microjbase", table: "schema_migrations" },
      ])
      const users = checks.find((c) => c.table === "users")
      const sessions = checks.find((c) => c.table === "sessions")
      expect(users?.hasSelect).toBe(true)
      expect(users?.hasInsert).toBe(true)
      expect(sessions?.hasSelect).toBe(true)
      expect(sessions?.hasInsert).toBe(true)
      expect(sessions?.hasUpdate).toBe(true)
    } finally {
      client.release()
    }
  })

  it("verifies applicable RLS policies for the runtime role on exposed tables", async () => {
    const tableName = `test_policy_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY;
        CREATE POLICY ${tableName}_all ON public.${tableName}
          FOR ALL TO ${RUNTIME_ROLE_NAME} USING (true) WITH CHECK (true);
      `)
    })

    const client = await pool.connect()
    try {
      const policies = await checkApplicablePolicies(client, [
        { schema: "public", table: tableName },
      ])
      expect(policies.length).toBeGreaterThan(0)
      expect(
        policies.some((p) => p.applicableRoles.includes(RUNTIME_ROLE_NAME)),
      ).toBe(true)
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName}`)
    })
  })

  it("rejects exposed tables with no RLS policies", async () => {
    const tableName = `test_no_policy_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY;
      `)
    })

    const client = await pool.connect()
    try {
      await expect(
        checkApplicablePolicies(client, [
          { schema: "public", table: tableName },
        ]),
      ).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message: `No row-level security policies exist for public.${tableName}`,
      })
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName}`)
    })
  })
})
