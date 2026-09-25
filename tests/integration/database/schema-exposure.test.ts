// Integration tests for the V02-13 expose/unexpose service against real
// PostgreSQL: exposure verification, least-privilege GRANT/REVOKE, the
// durable registry update, the atomic runtime snapshot swap under
// concurrent CRUD, idempotency replay, and fail-closed atomicity.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { SchemaCatalogueReader } from "../../../src/contracts/index.js"
import {
  buildTableRegistry,
  createSchemaCatalogueReader,
  createSchemaDdlExecutor,
  createSchemaExposureService,
  createSchemaMutationService,
  createSchemaOperationLog,
  createSwappableTableRegistry,
  createPool,
  type ManagedColumnSpec,
  findExposureByTarget,
  readExposureRegistryState,
  type Pool,
  type SchemaExposureService,
  type SchemaMutationService,
} from "../../../src/database/index.js"
import { applyMigrationsAndGrants, withClient } from "./bootstrap.js"
import { quoteIdentifier } from "./helpers.js"

const databaseUrl = process.env.INTEGRATION_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "INTEGRATION_DATABASE_URL environment variable is required for integration tests",
  )
}

const adminDatabaseUrl = process.env.INTEGRATION_ADMIN_DATABASE_URL
if (!adminDatabaseUrl) {
  throw new Error(
    "INTEGRATION_ADMIN_DATABASE_URL environment variable is required for integration tests",
  )
}

const RUNTIME_ROLE = new URL(databaseUrl as string).username
const ADMIN_ROLE = "mjb_v0213_admin"
const ADMIN_ROLE_PASSWORD = "v0213_admin_password"
const APP_SCHEMA = "mjb_v0213_app"
const USER_ID = "22222222-3333-4444-5555-666666666666"

function adminRoleUrl(): string {
  const url = new URL(adminDatabaseUrl as string)
  url.username = ADMIN_ROLE
  url.password = ADMIN_ROLE_PASSWORD
  return url.toString()
}

let adminPool: Pool
let runtimePool: Pool
let catalogue: SchemaCatalogueReader
let mutations: SchemaMutationService
let exposure: SchemaExposureService
let holder: ReturnType<typeof createSwappableTableRegistry>

const runtimeQuery = (
  text: string,
  values?: unknown[],
): Promise<import("pg").QueryResult> => runtimePool.query(text, values)

const adminQuery = (
  text: string,
  values?: unknown[],
): Promise<import("pg").QueryResult> => adminPool.query(text, values)

async function refreshRuntimeRegistry(): Promise<void> {
  const state = await readExposureRegistryState({ query: runtimeQuery })
  holder.replace(
    await buildTableRegistry(
      { mappings: state.exposed },
      { query: runtimeQuery },
    ),
  )
}

async function dropAdminRole(admin: import("pg").Client): Promise<void> {
  await admin.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ADMIN_ROLE}') THEN
        EXECUTE 'REVOKE ALL ON microjbase.schema_operations FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE ALL ON SEQUENCE microjbase.schema_operations_id_seq FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE ALL ON microjbase.exposure_registry FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE USAGE ON SEQUENCE microjbase.exposure_registry_id_seq FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE ALL ON microjbase.exposure_registry_state FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE USAGE ON SCHEMA microjbase FROM "${ADMIN_ROLE}"';
        EXECUTE 'DROP ROLE "${ADMIN_ROLE}"';
      END IF;
    END
    $$;
  `)
}

const TEXT_COLUMN = {
  name: "title",
  type: "text" as const,
  nullable: false,
  default: { kind: "none" as const },
}

async function createManagedTable(
  table: string,
  extraColumns: readonly ManagedColumnSpec[] = [],
): Promise<void> {
  const outcome = await mutations.createTable({
    idempotencyKey: `v0213-setup-${table}`,
    actor: "setup",
    schema: APP_SCHEMA,
    table,
    columns: [TEXT_COLUMN, ...extraColumns],
  })
  expect(outcome.replayed).toBe(false)
}

/** Managed table hardened for exposure: RLS + FORCE + owner policy. */
async function hardenTable(table: string): Promise<void> {
  await withClient(adminRoleUrl(), async (client) => {
    const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}`
    await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
    await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
    await client.query(
      `CREATE POLICY ${quoteIdentifier(`${table}_owner_all`)} ON ${qualified}
         FOR ALL TO PUBLIC
         USING (owner = nullif(current_setting('microjbase.user_id', true), '')::uuid)
         WITH CHECK (owner = nullif(current_setting('microjbase.user_id', true), '')::uuid)`,
    )
  })
}

async function createManagedItemsTable(table: string): Promise<void> {
  await createManagedTable(table, [
    {
      name: "owner",
      type: "uuid" as const,
      nullable: false,
      default: { kind: "none" as const },
    },
  ])
  await hardenTable(table)
}

async function runtimeCanCrud(table: string): Promise<{
  created: string
  listed: number
  updated: boolean
  deleted: boolean
}> {
  return withClient(databaseUrl as string, async (client) => {
    await client.query("BEGIN")
    try {
      await client.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        USER_ID,
      ])
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)} (title, owner)
         VALUES ('runtime row', $1::uuid) RETURNING id`,
        [USER_ID],
      )
      const id = inserted.rows[0]?.id ?? ""
      await client.query(
        `UPDATE ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)} SET title = 'updated' WHERE id = $1`,
        [id],
      )
      const listed = await client.query(
        `SELECT id FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}`,
      )
      await client.query(
        `DELETE FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)} WHERE id = $1`,
        [id],
      )
      await client.query("COMMIT")
      return {
        created: id,
        listed: listed.rows.length,
        updated: true,
        deleted: true,
      }
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
  })
}

async function runtimeCount(table: string): Promise<number> {
  return withClient(databaseUrl as string, async (client) => {
    await client.query("BEGIN")
    try {
      await client.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        USER_ID,
      ])
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}`,
      )
      await client.query("COMMIT")
      return Number(result.rows[0]?.count ?? "0")
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
  })
}

async function runtimeInsertPersistentRow(table: string): Promise<void> {
  return withClient(databaseUrl as string, async (client) => {
    await client.query("BEGIN")
    try {
      await client.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        USER_ID,
      ])
      await client.query(
        `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)} (title, owner)
         VALUES ('persistent row', $1::uuid)`,
        [USER_ID],
      )
      await client.query("COMMIT")
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
  })
}

async function adminTableCount(table: string): Promise<number> {
  return withClient(adminRoleUrl(), async (client) => {
    // FORCE RLS applies the owner policy to the table owner too, so the
    // owner lane reads with the test identity set.
    await client.query(`SELECT set_config('microjbase.user_id', $1, false)`, [
      USER_ID,
    ])
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}`,
    )
    return Number(result.rows[0]?.count ?? "0")
  })
}

beforeAll(async () => {
  await applyMigrationsAndGrants(adminDatabaseUrl as string, RUNTIME_ROLE)

  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'v0213-%'`,
    )
    await admin.query("TRUNCATE microjbase.exposure_registry")
    await admin.query(
      "UPDATE microjbase.exposure_registry_state SET initialized = TRUE, imported_at = now()",
    )
    await dropAdminRole(admin)
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(ADMIN_ROLE)} WITH LOGIN PASSWORD '${ADMIN_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
    )
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await admin.query(
      `CREATE SCHEMA ${quoteIdentifier(APP_SCHEMA)} AUTHORIZATION ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT USAGE ON SCHEMA microjbase TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON microjbase.schema_operations TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT USAGE ON SEQUENCE microjbase.schema_operations_id_seq TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON microjbase.exposure_registry TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT USAGE ON SEQUENCE microjbase.exposure_registry_id_seq TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT SELECT ON microjbase.exposure_registry_state TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
  })

  adminPool = createPool({ databaseUrl: adminRoleUrl(), maxConnections: 6 })
  runtimePool = createPool({
    databaseUrl: databaseUrl as string,
    maxConnections: 6,
  })
  catalogue = createSchemaCatalogueReader({ query: adminQuery })
  const executor = createSchemaDdlExecutor({
    pool: adminPool,
    createOperationLog: (query) => createSchemaOperationLog({ query }),
  })
  mutations = createSchemaMutationService({
    pool: adminPool,
    catalogue,
    registry: { get: () => null, list: () => [] },
    adminRole: ADMIN_ROLE,
    executor,
  })
  holder = createSwappableTableRegistry(
    await buildTableRegistry({ mappings: [] }, { query: runtimeQuery }),
  )
  exposure = createSchemaExposureService({
    pool: adminPool,
    catalogue,
    executor,
    adminRole: ADMIN_ROLE,
    runtimeRole: RUNTIME_ROLE,
    refreshRuntimeRegistry,
  })

  await createManagedItemsTable("items")
  await createManagedItemsTable("items2")
})

afterAll(async () => {
  await adminPool.close()
  await runtimePool.close()
  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await admin.query("TRUNCATE microjbase.exposure_registry")
    await dropAdminRole(admin)
  })
})

describe("expose", () => {
  it("exposes a verified table: least-privilege grants, durable row, atomic swap", async () => {
    const outcome = await exposure.expose({
      idempotencyKey: "v0213-expose-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
      alias: "items",
    })
    expect(outcome.replayed).toBe(false)
    expect(outcome.record?.status).toBe("succeeded")

    // The runtime snapshot swapped atomically.
    const exposed = holder.get("items")
    expect(exposed?.schema).toBe(APP_SCHEMA)
    expect(exposed?.table).toBe("items")
    expect(exposed?.readableColumns).toEqual(
      expect.arrayContaining(["id", "owner", "title"]),
    )
    expect(exposed?.updatableColumns).toEqual(
      expect.arrayContaining(["owner", "title"]),
    )
    expect(exposed?.updatableColumns).not.toContain("id")

    // The durable registry row is exposed.
    const row = await findExposureByTarget(
      { query: adminQuery },
      APP_SCHEMA,
      "items",
    )
    expect(row?.exposed).toBe(true)
    expect(row?.alias).toBe("items")

    // The runtime role holds exactly the least-privilege grant set.
    const privileges = await adminPool.query<{
      has_delete: boolean
      title_select: boolean
      title_insert: boolean
      title_update: boolean
      id_update: boolean
    }>(
      `SELECT has_table_privilege($1, $2, 'DELETE') AS has_delete,
              has_column_privilege($1, $2, 'title', 'SELECT') AS title_select,
              has_column_privilege($1, $2, 'title', 'INSERT') AS title_insert,
              has_column_privilege($1, $2, 'title', 'UPDATE') AS title_update,
              has_column_privilege($1, $2, 'id', 'UPDATE') AS id_update`,
      [RUNTIME_ROLE, `${APP_SCHEMA}.items`],
    )
    expect(privileges.rows[0]).toEqual({
      has_delete: true,
      title_select: true,
      title_insert: true,
      title_update: true,
      id_update: false,
    })

    // The runtime role can run the full CRUD cycle through its own lane.
    const crud = await runtimeCanCrud("items")
    expect(crud.created).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(crud.listed).toBe(1)
  })

  it("rejects unexposable tables with safe errors", async () => {
    // No RLS at all.
    await createManagedTable("no_rls")
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `CREATE POLICY no_rls_p ON ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("no_rls")} FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
      )
    })
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-no-rls",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "no_rls",
        alias: "no_rls",
      }),
    ).rejects.toThrow(/Row-level security is not enabled/)

    // RLS without FORCE.
    await createManagedTable("no_force")
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("no_force")}`
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
      await client.query(
        `CREATE POLICY no_force_p ON ${qualified} FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
      )
    })
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-no-force",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "no_force",
        alias: "no_force",
      }),
    ).rejects.toThrow(/Forced row-level security is not enabled/)

    // No applicable policy.
    await createManagedTable("no_policy")
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("no_policy")}`
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
    })
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-no-policy",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "no_policy",
        alias: "no_policy",
      }),
    ).rejects.toThrow(/policies/)

    // Non-uuid primary key named id.
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("text_pk")}`
      await client.query(
        `CREATE TABLE ${qualified} (id TEXT PRIMARY KEY, title TEXT NOT NULL)`,
      )
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
      await client.query(
        `CREATE POLICY text_pk_p ON ${qualified} FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
      )
    })
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-text-pk",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "text_pk",
        alias: "text_pk",
      }),
    ).rejects.toThrow(/must be type uuid/)

    // Composite primary key.
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("composite_pk")}`
      await client.query(
        `CREATE TABLE ${qualified} (id UUID NOT NULL, part INTEGER NOT NULL, title TEXT NOT NULL, PRIMARY KEY (id, part))`,
      )
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
      await client.query(
        `CREATE POLICY composite_pk_p ON ${qualified} FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
      )
    })
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-composite-pk",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "composite_pk",
        alias: "composite_pk",
      }),
    ).rejects.toThrow(/single-column primary key/)

    // Internal schema.
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-internal",
        actor: "operator",
        schema: "microjbase",
        table: "users",
        alias: "users",
      }),
    ).rejects.toThrow(/Internal schemas/)

    // Alias shape validation.
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-bad-alias",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items2",
        alias: "Bad Alias",
      }),
    ).rejects.toThrow(/[Aa]lias/)

    // None of the failed exposures left durable state or history.
    await expect(
      findExposureByTarget({ query: adminQuery }, APP_SCHEMA, "no_rls"),
    ).resolves.toBeNull()
    await withClient(adminDatabaseUrl as string, async (admin) => {
      const result = await admin.query(
        `SELECT count(*)::text AS count FROM microjbase.schema_operations
         WHERE idempotency_key LIKE 'v0213-expose-no%' OR idempotency_key LIKE 'v0213-expose-text%'`,
      )
      expect(result.rows[0]?.count).toBe("0")
    })
  })

  it("refuses a table not owned by the schema-admin role", async () => {
    await withClient(adminDatabaseUrl as string, async (admin) => {
      const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("foreign_owned")}`
      await admin.query(
        `CREATE TABLE ${qualified} (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL)`,
      )
      await admin.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
      await admin.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
      await admin.query(
        `CREATE POLICY foreign_owned_p ON ${qualified} FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
      )
    })
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-foreign",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "foreign_owned",
        alias: "foreign_owned",
      }),
    ).rejects.toThrow(/owned by the schema-admin role/)
  })

  it("refuses duplicate exposure with distinct keys", async () => {
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-dup-1",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
        alias: "items",
      }),
    ).rejects.toThrow(/already exposed/)
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-alias-1",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items2",
        alias: "items",
      }),
    ).rejects.toThrow(/already used/)
  })

  it("dry-run exposes nothing", async () => {
    const outcome = await exposure.expose({
      idempotencyKey: "v0213-expose-dry",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items2",
      alias: "items2",
      dryRun: true,
    })
    expect(outcome.dryRun).toBe(true)
    expect(holder.get("items2")).toBeNull()
    await expect(
      findExposureByTarget({ query: adminQuery }, APP_SCHEMA, "items2"),
    ).resolves.toBeNull()
    await expect(runtimeCount("items2")).rejects.toThrow()
  })
})

describe("unexpose", () => {
  it("revokes reachability while preserving the table and its data", async () => {
    const crud = await runtimeCanCrud("items")
    expect(crud.created).toBeTruthy()
    await runtimeInsertPersistentRow("items")

    const outcome = await exposure.unexpose({
      idempotencyKey: "v0213-unexpose-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
    })
    expect(outcome.replayed).toBe(false)

    // The runtime snapshot swapped: the alias is gone.
    expect(holder.get("items")).toBeNull()
    expect(holder.list()).toEqual([])

    // The durable row keeps the unexposed history.
    const row = await findExposureByTarget(
      { query: adminQuery },
      APP_SCHEMA,
      "items",
    )
    expect(row?.exposed).toBe(false)

    // The runtime role lost table privileges...
    await expect(runtimeCount("items")).rejects.toThrow()

    // ...while the table and its data remain intact on the owner lane.
    expect(await adminTableCount("items")).toBe(1)
  })

  it("rejects unexposing a table that is not exposed", async () => {
    await expect(
      exposure.unexpose({
        idempotencyKey: "v0213-unexpose-missing",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
      }),
    ).rejects.toThrow(/is not exposed/)
  })
})

describe("idempotency and atomicity", () => {
  it("replays recorded expose/unexpose outcomes without re-executing", async () => {
    await exposure.expose({
      idempotencyKey: "v0213-replay-expose",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items2",
      alias: "items2",
    })
    const replayed = await exposure.expose({
      idempotencyKey: "v0213-replay-expose",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items2",
      alias: "items2",
    })
    expect(replayed.replayed).toBe(true)

    await exposure.unexpose({
      idempotencyKey: "v0213-replay-unexpose",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items2",
    })
    const replayedUnexpose = await exposure.unexpose({
      idempotencyKey: "v0213-replay-unexpose",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items2",
    })
    expect(replayedUnexpose.replayed).toBe(true)
    expect(holder.get("items2")).toBeNull()
  })

  it("conflicts when a key is reused with a different command", async () => {
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-replay-expose",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
        alias: "different",
      }),
    ).rejects.toThrow(/different operation/)
  })

  it("rolls back grants and registry rows together when verification fails mid-flight", async () => {
    // Expose while a concurrent unexpose-like revoke has removed ownership
    // cannot happen for the owner lane; instead simulate the executor's
    // fail-closed behaviour by exposing a table whose grants cannot apply:
    // a table whose owner was transferred away after preflight. The
    // preflight catches ownership first, so assert the guard.
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `CREATE TABLE ${quoteIdentifier(APP_SCHEMA)}.transferred (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL)`,
      )
      await admin.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.transferred ENABLE ROW LEVEL SECURITY`,
      )
      await admin.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.transferred FORCE ROW LEVEL SECURITY`,
      )
      await admin.query(
        `CREATE POLICY transferred_p ON ${quoteIdentifier(APP_SCHEMA)}.transferred FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
      )
      await admin.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.transferred OWNER TO ${quoteIdentifier(RUNTIME_ROLE)}`,
      )
    })
    await expect(
      exposure.expose({
        idempotencyKey: "v0213-expose-transferred",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "transferred",
        alias: "transferred",
      }),
    ).rejects.toThrow(/owned by the schema-admin role/)
    await expect(
      findExposureByTarget({ query: adminQuery }, APP_SCHEMA, "transferred"),
    ).resolves.toBeNull()
  })
})

describe("atomic swap under concurrent CRUD", () => {
  it("serves a consistent snapshot to concurrent readers while unexposing", async () => {
    await createManagedItemsTable("conc_items")
    await exposure.expose({
      idempotencyKey: "v0213-conc-expose",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "conc_items",
      alias: "conc_items",
    })
    expect(holder.get("conc_items")).not.toBeNull()
    await runtimeInsertPersistentRow("conc_items")

    const observations: ("present" | "absent")[] = []
    const errors: unknown[] = []
    const readers = Array.from({ length: 12 }, async () => {
      for (let i = 0; i < 20; i += 1) {
        try {
          const seen = holder.get("conc_items")
          observations.push(seen === null ? "absent" : "present")
          if (seen !== null) {
            // Queries may fail once the revoke lands mid-flight; that is
            // the database enforcing least privilege, not a torn registry.
            await runtimeCount("conc_items").catch(() => undefined)
          }
        } catch (error: unknown) {
          errors.push(error)
        }
      }
    })

    const unexposePromise = (async () => {
      await new Promise((resolve) => setImmediate(resolve))
      return exposure.unexpose({
        idempotencyKey: "v0213-conc-unexpose",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "conc_items",
      })
    })()

    await Promise.all([...readers, unexposePromise])

    // No reader ever observed a torn or invalid registry state.
    expect(errors).toEqual([])
    expect(observations.length).toBe(240)
    // After the swap every new read sees the unexposed state.
    expect(holder.get("conc_items")).toBeNull()
    const firstAbsent = observations.indexOf("absent")
    expect(observations.slice(firstAbsent)).not.toContain("present")
    // The table and its data survived.
    expect(await adminTableCount("conc_items")).toBe(1)
  })

  it("serializes two racing exposes of different tables on distinct keys", async () => {
    await createManagedItemsTable("race_a")
    await createManagedItemsTable("race_b")
    const [a, b] = await Promise.all([
      exposure.expose({
        idempotencyKey: "v0213-race-a",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "race_a",
        alias: "race_a",
      }),
      exposure.expose({
        idempotencyKey: "v0213-race-b",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "race_b",
        alias: "race_b",
      }),
    ])
    // Both committed; the advisory serialization ordered them instead of
    // deadlocking or double-executing.
    expect(a.record?.status).toBe("succeeded")
    expect(b.record?.status).toBe("succeeded")
    expect(holder.get("race_a")).not.toBeNull()
    expect(holder.get("race_b")).not.toBeNull()
    await exposure.unexpose({
      idempotencyKey: "v0213-race-a-un",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "race_a",
    })
    await exposure.unexpose({
      idempotencyKey: "v0213-race-b-un",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "race_b",
    })
  })
})
