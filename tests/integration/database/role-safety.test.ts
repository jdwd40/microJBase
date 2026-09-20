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
import { quoteIdentifier, quoteLiteral } from "./helpers.js"

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

function runtimeRoleId(): string {
  return quoteIdentifier(RUNTIME_ROLE_NAME)
}

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
          `CREATE ROLE ${quoteIdentifier(roleName)} WITH LOGIN BYPASSRLS PASSWORD ${quoteLiteral(password)}`,
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
        await admin
          .query(`DROP ROLE IF EXISTS ${quoteIdentifier(roleName)}`)
          .catch(() => {
            // ignore cleanup failure
          })
      }
    })
  })

  it("checks table ownership and RLS", async () => {
    const tableName = `test_rls_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${quoteIdentifier(tableName)} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID,
          title TEXT
        );
        ALTER TABLE public.${quoteIdentifier(tableName)} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${quoteIdentifier(tableName)} FORCE ROW LEVEL SECURITY;
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
      await admin.query(
        `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`,
      )
    })
  })

  it("fails when RLS is disabled", async () => {
    const tableName = `test_no_rls_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${quoteIdentifier(tableName)} (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
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
      await admin.query(
        `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`,
      )
    })
  })

  it("rejects exposed tables with RLS enabled but forced RLS disabled", async () => {
    const tableName = `test_no_force_rls_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${quoteIdentifier(tableName)} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${quoteIdentifier(tableName)} ENABLE ROW LEVEL SECURITY;
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
      await admin.query(
        `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`,
      )
    })
  })

  it("rejects exposed tables owned by the runtime role without forced RLS", async () => {
    const tableName = `test_runtime_owned_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${quoteIdentifier(tableName)} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${quoteIdentifier(tableName)} OWNER TO ${runtimeRoleId()};
        ALTER TABLE public.${quoteIdentifier(tableName)} ENABLE ROW LEVEL SECURITY;
      `)
    })

    const runtimeClient = new pg.Client({ connectionString: databaseUrl })
    await runtimeClient.connect()
    try {
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
        .query(`DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`)
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
        CREATE TABLE public.${quoteIdentifier(tableName)} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${quoteIdentifier(tableName)} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${quoteIdentifier(tableName)} FORCE ROW LEVEL SECURITY;
        CREATE POLICY ${quoteIdentifier(`${tableName}_all`)} ON public.${quoteIdentifier(tableName)}
          FOR ALL TO ${runtimeRoleId()} USING (true) WITH CHECK (true);
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
      await admin.query(
        `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`,
      )
    })
  })

  it("accepts policies applying to PUBLIC", async () => {
    const tableName = `test_policy_public_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${quoteIdentifier(tableName)} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${quoteIdentifier(tableName)} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${quoteIdentifier(tableName)} FORCE ROW LEVEL SECURITY;
        CREATE POLICY ${quoteIdentifier(`${tableName}_public`)} ON public.${quoteIdentifier(tableName)}
          FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
      `)
    })

    const client = await pool.connect()
    try {
      const policies = await checkApplicablePolicies(client, [
        { schema: "public", table: tableName },
      ])
      expect(policies.length).toBeGreaterThan(0)
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`,
      )
    })
  })

  it("accepts policies applying through inherited role membership", async () => {
    const tableName = `test_policy_inherited_${Date.now()}`
    const parentRole = `test_parent_role_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(parentRole)} WITH LOGIN PASSWORD ${quoteLiteral("parent_password")} NOINHERIT`,
      )
      await admin.query(
        `GRANT ${quoteIdentifier(parentRole)} TO ${runtimeRoleId()}`,
      )
      await admin.query(`
        CREATE TABLE public.${quoteIdentifier(tableName)} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${quoteIdentifier(tableName)} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${quoteIdentifier(tableName)} FORCE ROW LEVEL SECURITY;
        CREATE POLICY ${quoteIdentifier(`${tableName}_inherited`)} ON public.${quoteIdentifier(tableName)}
          FOR ALL TO ${quoteIdentifier(parentRole)} USING (true) WITH CHECK (true);
      `)
    })

    const client = await pool.connect()
    try {
      const policies = await checkApplicablePolicies(client, [
        { schema: "public", table: tableName },
      ])
      expect(policies.length).toBeGreaterThan(0)
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`,
      )
      await admin.query(
        `REVOKE ${quoteIdentifier(parentRole)} FROM ${runtimeRoleId()}`,
      )
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(parentRole)}`)
    })
  })

  it("rejects exposed tables with no RLS policies", async () => {
    const tableName = `test_no_policy_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(`
        CREATE TABLE public.${quoteIdentifier(tableName)} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${quoteIdentifier(tableName)} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${quoteIdentifier(tableName)} FORCE ROW LEVEL SECURITY;
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
      await admin.query(
        `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`,
      )
    })
  })

  it("rejects exposed tables with policies only for unrelated roles", async () => {
    const tableName = `test_unrelated_policy_${Date.now()}`
    const otherRole = `test_other_role_${Date.now()}`
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(otherRole)} WITH LOGIN PASSWORD ${quoteLiteral("other_password")}`,
      )
      await admin.query(`
        CREATE TABLE public.${quoteIdentifier(tableName)} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID
        );
        ALTER TABLE public.${quoteIdentifier(tableName)} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.${quoteIdentifier(tableName)} FORCE ROW LEVEL SECURITY;
        CREATE POLICY ${quoteIdentifier(`${tableName}_other`)} ON public.${quoteIdentifier(tableName)}
          FOR ALL TO ${quoteIdentifier(otherRole)} USING (true) WITH CHECK (true);
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
        message: `No row-level security policies on public.${tableName} apply to the runtime role`,
      })
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `DROP TABLE IF EXISTS public.${quoteIdentifier(tableName)}`,
      )
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(otherRole)}`)
    })
  })

  it("fails closed when schema USAGE privilege is missing", async () => {
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `REVOKE USAGE ON SCHEMA microjbase FROM ${runtimeRoleId()};`,
      )
    })

    const client = await pool.connect()
    try {
      await expect(checkRuntimeRoleSafety(client)).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message:
          "Runtime role is missing required privilege USAGE on schema microjbase",
      })
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `GRANT USAGE ON SCHEMA microjbase TO ${runtimeRoleId()};`,
      )
    })
  })

  it("fails closed when SELECT on schema_migrations is missing", async () => {
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `REVOKE SELECT ON microjbase.schema_migrations FROM ${runtimeRoleId()};`,
      )
    })

    const client = await pool.connect()
    try {
      await expect(checkRuntimeRoleSafety(client)).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message:
          "Runtime role is missing required privilege SELECT on microjbase.schema_migrations",
      })
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `GRANT SELECT ON microjbase.schema_migrations TO ${runtimeRoleId()};`,
      )
    })
  })

  it("fails closed when INSERT on users is missing", async () => {
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `REVOKE INSERT ON microjbase.users FROM ${runtimeRoleId()};`,
      )
    })

    const client = await pool.connect()
    try {
      await expect(checkRuntimeRoleSafety(client)).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message:
          "Runtime role is missing required privilege INSERT on microjbase.users",
      })
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `GRANT INSERT ON microjbase.users TO ${runtimeRoleId()};`,
      )
    })
  })

  it("fails closed when UPDATE on sessions is missing", async () => {
    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `REVOKE UPDATE ON microjbase.sessions FROM ${runtimeRoleId()};`,
      )
    })

    const client = await pool.connect()
    try {
      await expect(checkRuntimeRoleSafety(client)).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message:
          "Runtime role is missing required privilege UPDATE on microjbase.sessions",
      })
    } finally {
      client.release()
    }

    await withClient(adminDatabaseUrl, async (admin) => {
      await admin.query(
        `GRANT UPDATE ON microjbase.sessions TO ${runtimeRoleId()};`,
      )
    })
  })
})
