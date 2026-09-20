import { describe, expect, it, beforeAll, afterAll } from "vitest"
import pg from "pg"

import {
  buildTableRegistry,
  buildTableRegistryFromEnv,
  createPool,
  type Pool,
} from "../../../src/database/index.js"
import {
  applyMigrationsAndGrants,
  cleanMigrations,
  withClient,
} from "./bootstrap.js"
import { quoteIdentifier } from "./helpers.js"

const databaseUrl =
  process.env.INTEGRATION_DATABASE_URL ??
  "postgres://microjbase_runtime:***@127.0.0.1:5432/microjbase_dev"

const adminDatabaseUrl =
  process.env.INTEGRATION_ADMIN_DATABASE_URL ??
  process.env.MIGRATION_DATABASE_URL ??
  "postgres://microjbase:***@127.0.0.1:5432/microjbase_dev"

const runtimeRoleName = new URL(databaseUrl).username

async function withAdminClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(adminDatabaseUrl, fn)
}

async function withRuntimeClient<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

async function createTestTable(
  name: string,
  options: {
    rls?: boolean
    forceRls?: boolean
    primaryKey?: { name: string; type: string }
    columns?: string
    grant?: boolean
    policy?: boolean
    policyRole?: string
    extraSql?: string
  } = {},
): Promise<void> {
  const pkName = options.primaryKey?.name ?? "id"
  const pkType = options.primaryKey?.type ?? "uuid"
  const columns = options.columns ?? "title text"

  await withAdminClient(async (admin) => {
    await admin.query(`DROP TABLE IF EXISTS public.${name} CASCADE`)
    await admin.query(`
      CREATE TABLE public.${name} (
        ${pkName} ${pkType} PRIMARY KEY ${pkType === "uuid" ? "DEFAULT gen_random_uuid()" : ""},
        user_id uuid NOT NULL DEFAULT (nullif(current_setting('microjbase.user_id', true), '')::uuid),
        ${columns}
      )
    `)

    if (options.rls ?? true) {
      await admin.query(`ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY`)
    }
    if (options.forceRls ?? true) {
      await admin.query(`ALTER TABLE public.${name} FORCE ROW LEVEL SECURITY`)
    }

    if (options.grant ?? true) {
      const role = quoteIdentifier(runtimeRoleName)
      await admin.query(`
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.${name} TO ${role}
      `)
    }

    if (options.policy ?? true) {
      const role = options.policyRole
        ? quoteIdentifier(options.policyRole)
        : "PUBLIC"
      await admin.query(`
        DROP POLICY IF EXISTS ${name}_owner ON public.${name};
        CREATE POLICY ${name}_owner ON public.${name}
          FOR ALL
          TO ${role}
          USING (
            user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid
          )
          WITH CHECK (
            user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid
          )
      `)
    }

    if (options.extraSql) {
      await admin.query(options.extraSql)
    }
  })
}

async function dropTestTable(name: string): Promise<void> {
  await withAdminClient(async (admin) => {
    await admin.query(`DROP TABLE IF EXISTS public.${name} CASCADE`)
  })
}

let pool: Pool

describe("table registry", () => {
  beforeAll(async () => {
    await cleanMigrations(adminDatabaseUrl)
    await applyMigrationsAndGrants(adminDatabaseUrl, runtimeRoleName)
    await withAdminClient(async (admin) => {
      const role = quoteIdentifier(runtimeRoleName)
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO ${role}`,
      )
    })
    pool = createPool({ databaseUrl, maxConnections: 2 })
  })

  afterAll(async () => {
    await pool.close()
    await cleanMigrations(adminDatabaseUrl)
  })

  it("accepts the configured todos table", async () => {
    await withRuntimeClient(async (client) => {
      const registry = await buildTableRegistry(
        { mappings: [{ alias: "todos", schema: "public", table: "todos" }] },
        { query: (text, values) => client.query(text, values) },
      )

      const table = registry.get("todos")
      expect(table).not.toBeNull()
      expect(table?.schema).toBe("public")
      expect(table?.table).toBe("todos")
      expect(table?.primaryKey).toBe("id")
      expect(table?.readableColumns).toContain("id")
      expect(table?.readableColumns).toContain("title")
      expect(table?.insertableColumns).not.toContain("id")
      expect(table?.updatableColumns).not.toContain("id")
    })
  })

  it("rejects malformed identifier", async () => {
    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [{ alias: "bad", schema: "public", table: "todos;drop" }],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("Invalid table identifier"),
    })
  })

  it("rejects duplicate alias", async () => {
    await expect(
      buildTableRegistryFromEnv("todos=public.todos,todos=public.todos", {
        query: async () => ({
          rows: [],
          command: "SELECT",
          rowCount: 0,
          oid: 0,
          fields: [],
        }),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(
        'alias "todos" is defined more than once',
      ),
    })
  })

  it("rejects duplicate physical target", async () => {
    await expect(
      buildTableRegistryFromEnv("a=public.todos,b=public.todos", {
        query: async () => ({
          rows: [],
          command: "SELECT",
          rowCount: 0,
          oid: 0,
          fields: [],
        }),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(
        'target "public.todos" is mapped more than once',
      ),
    })
  })

  it("rejects reserved schema", async () => {
    await expect(
      buildTableRegistryFromEnv("bad=microjbase.users", {
        query: async () => ({
          rows: [],
          command: "SELECT",
          rowCount: 0,
          oid: 0,
          fields: [],
        }),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining('schema "microjbase" cannot be exposed'),
    })
  })

  it("rejects missing table", async () => {
    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              {
                alias: "missing",
                schema: "public",
                table: "does_not_exist_12345",
              },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("does not exist"),
    })
  })

  it("rejects non-UUID id", async () => {
    const tableName = `test_bad_pk_${Date.now()}`
    await createTestTable(tableName, {
      primaryKey: { name: "id", type: "text" },
    })

    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              { alias: tableName, schema: "public", table: tableName },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("must be type uuid"),
    })

    await dropTestTable(tableName)
  })

  it("rejects primary key not named id", async () => {
    const tableName = `test_pk_name_${Date.now()}`
    await createTestTable(tableName, {
      primaryKey: { name: "pk", type: "uuid" },
    })

    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              { alias: tableName, schema: "public", table: tableName },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining('must be named "id"'),
    })

    await dropTestTable(tableName)
  })

  it("rejects composite primary key", async () => {
    const tableName = `test_composite_pk_${Date.now()}`
    await withAdminClient(async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName} CASCADE`)
      await admin.query(`
        CREATE TABLE public.${tableName} (
          id uuid,
          user_id uuid,
          PRIMARY KEY (id, user_id)
        )
      `)
      await admin.query(
        `ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY`,
      )
      await admin.query(
        `ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY`,
      )
      const role = quoteIdentifier(runtimeRoleName)
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.${tableName} TO ${role}`,
      )
      await admin.query(`
        CREATE POLICY ${tableName}_owner ON public.${tableName}
          FOR ALL TO PUBLIC
          USING (user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid)
          WITH CHECK (user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid)
      `)
    })

    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              { alias: tableName, schema: "public", table: tableName },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("no single-column primary key"),
    })

    await dropTestTable(tableName)
  })

  it("rejects RLS-disabled table", async () => {
    const tableName = `test_no_rls_${Date.now()}`
    await createTestTable(tableName, { rls: false, forceRls: false })

    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              { alias: tableName, schema: "public", table: tableName },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("Row-level security is not enabled"),
    })

    await dropTestTable(tableName)
  })

  it("rejects non-FORCE-RLS table", async () => {
    const tableName = `test_no_force_rls_${Date.now()}`
    await createTestTable(tableName, { forceRls: false })

    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              { alias: tableName, schema: "public", table: tableName },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining(
        "Forced row-level security is not enabled",
      ),
    })

    await dropTestTable(tableName)
  })

  it("rejects policy for unrelated role", async () => {
    const tableName = `test_unrelated_policy_${Date.now()}`
    await createTestTable(tableName, { policyRole: "microjbase" })

    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              { alias: tableName, schema: "public", table: tableName },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("apply to the runtime role"),
    })

    await dropTestTable(tableName)
  })

  it("rejects missing effective privilege", async () => {
    const tableName = `test_no_priv_${Date.now()}`
    await createTestTable(tableName, { grant: false })

    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              { alias: tableName, schema: "public", table: tableName },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("no readable columns"),
    })

    await dropTestTable(tableName)
  })

  it("rejects unsupported/unusable table", async () => {
    const tableName = `test_unsupported_${Date.now()}`
    await withAdminClient(async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName} CASCADE`)
      await admin.query(`
        CREATE TABLE public.${tableName} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          data bytea
        )
      `)
      await admin.query(
        `ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY`,
      )
      await admin.query(
        `ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY`,
      )
      const role = quoteIdentifier(runtimeRoleName)
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.${tableName} TO ${role}`,
      )
      await admin.query(`
        CREATE POLICY ${tableName}_owner ON public.${tableName}
          FOR ALL TO PUBLIC
          USING (true)
          WITH CHECK (true)
      `)
    })

    await expect(
      withRuntimeClient(async (client) => {
        await buildTableRegistry(
          {
            mappings: [
              { alias: tableName, schema: "public", table: tableName },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        )
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: expect.stringContaining("no insertable columns"),
    })

    await dropTestTable(tableName)
  })

  it("derives readable/insertable/updatable metadata correctly", async () => {
    const tableName = `test_meta_${Date.now()}`
    await withAdminClient(async (admin) => {
      await admin.query(`DROP TABLE IF EXISTS public.${tableName} CASCADE`)
      await admin.query(`
        CREATE TABLE public.${tableName} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL DEFAULT (nullif(current_setting('microjbase.user_id', true), '')::uuid),
          title text NOT NULL,
          count integer NOT NULL DEFAULT 0,
          secret text GENERATED ALWAYS AS ('x') STORED,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await admin.query(
        `ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY`,
      )
      await admin.query(
        `ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY`,
      )
      const role = quoteIdentifier(runtimeRoleName)
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.${tableName} TO ${role}`,
      )
      await admin.query(`
        CREATE POLICY ${tableName}_owner ON public.${tableName}
          FOR ALL TO PUBLIC
          USING (user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid)
          WITH CHECK (user_id = nullif(current_setting('microjbase.user_id', true), '')::uuid)
      `)
    })

    await withRuntimeClient(async (client) => {
      const registry = await buildTableRegistry(
        {
          mappings: [{ alias: tableName, schema: "public", table: tableName }],
        },
        { query: (text, values) => client.query(text, values) },
      )
      const table = registry.get(tableName)
      expect(table).not.toBeNull()
      expect(table?.readableColumns).toEqual(
        expect.arrayContaining(["id", "title", "count", "created_at"]),
      )
      expect(table?.readableColumns).not.toContain("secret")
      expect(table?.insertableColumns).toEqual(
        expect.arrayContaining(["title", "count"]),
      )
      expect(table?.insertableColumns).not.toContain("id")
      expect(table?.insertableColumns).not.toContain("secret")
      expect(table?.updatableColumns).toEqual(
        expect.arrayContaining(["title", "count"]),
      )
      expect(table?.updatableColumns).not.toContain("id")
      expect(table?.updatableColumns).not.toContain("secret")
    })

    await dropTestTable(tableName)
  })
})
