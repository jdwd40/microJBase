// Integration tests for the JDW-27 schema-mutation security remediations,
// run against real PostgreSQL 18.6:
//
//  1. (High) disable/drop interleaving: once a table is exposed, the locked
//     exposure guard refuses RLS disablement and structural drops with a
//     mapped CONFLICT (SQLSTATE 9C003) even though the in-memory registry the
//     preflight read can be stale by the time the executor reaches the lock.
//  3. (Med) expose rejects a broader permissive policy: a permissive
//     USING (true) policy beside the module-owned ownership policies fails
//     verification closed instead of letting one tenant read another's rows.
//  4. (Med) cascading referential actions refuse exposed tables: ON DELETE
//     CASCADE / SET NULL is refused (9C003) when either end of the key is
//     exposed, because the action rewrites rows as the owner, bypassing RLS.
//  5. (Med) the runtime catalogue probes are pg_catalog-qualified: a forged
//     first search_path entry cannot make buildTableRegistry or
//     checkTableOwnershipAndRls report a forged relrowsecurity.
//
// Verification command (PostgreSQL 18.6, workspace-local cluster):
//   INTEGRATION_DATABASE_URL=postgres://microjbase_runtime@127.0.0.1:55432/microjbase_integration_test \
//   INTEGRATION_ADMIN_DATABASE_URL=postgres://microjbase@127.0.0.1:55432/microjbase_integration_test \
//   npx vitest run --project integration tests/integration/database/jdw27-guards.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pg from "pg"

import type { SchemaCatalogueReader } from "../../../src/contracts/index.js"
import { AppError } from "../../../src/core/index.js"
import {
  buildTableRegistry,
  checkTableOwnershipAndRls,
  createSchemaCatalogueReader,
  createSchemaConstraintService,
  createSchemaDdlExecutor,
  createSchemaExposureService,
  createSchemaMutationService,
  createSchemaOperationLog,
  createSchemaPolicyService,
  createSchemaRlsService,
  createSwappableTableRegistry,
  createPool,
  findExposureByTarget,
  type ManagedColumnSpec,
  ownershipPolicyName,
  type Pool,
  readExposureRegistryState,
  type SchemaConstraintService,
  type SchemaExposureService,
  type SchemaMutationService,
  type SchemaPolicyService,
  type SchemaRlsService,
} from "../../../src/database/index.js"
import { applyMigrationsAndGrants, withClient } from "./bootstrap.js"
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
    "INTEGRATION_ADMIN_DATABASE_URL environment variable is required for integration tests",
  )
}

const RUNTIME_ROLE = new URL(databaseUrl as string).username
const ADMIN_ROLE = "mjb_jdw27_admin"
const ADMIN_ROLE_PASSWORD = "jdw27_admin_password"
const APP_SCHEMA = "mjb_jdw27_app"

function adminRoleUrl(): string {
  const url = new URL(adminDatabaseUrl as string)
  url.username = ADMIN_ROLE
  url.password = ADMIN_ROLE_PASSWORD
  return url.toString()
}

let adminPool: Pool
let catalogue: SchemaCatalogueReader
let mutations: SchemaMutationService
let rls: SchemaRlsService
let policies: SchemaPolicyService
let constraints: SchemaConstraintService
let exposure: SchemaExposureService
let holder: ReturnType<typeof createSwappableTableRegistry>

const TEXT_COLUMN = {
  name: "title",
  type: "text" as const,
  nullable: false,
  default: { kind: "none" as const },
}

const OWNER_COLUMN: ManagedColumnSpec = {
  name: "owner",
  type: "uuid" as const,
  nullable: false,
  default: { kind: "none" as const },
}

async function createManagedTable(
  table: string,
  extraColumns: readonly ManagedColumnSpec[] = [],
): Promise<void> {
  const outcome = await mutations.createTable({
    idempotencyKey: `jdw27-setup-${table}`,
    actor: "setup",
    schema: APP_SCHEMA,
    table,
    columns: [TEXT_COLUMN, ...extraColumns],
  })
  expect(outcome.replayed).toBe(false)
}

// RLS + FORCE + the four module-owned ownership policies verification needs.
// The shapes are inlined (rather than taken from ownershipPolicyTemplateShape)
// so this file runs against both the pre-fix and fixed compilers.
const OWNERSHIP_SHAPES: Readonly<
  {
    template: "read" | "insert" | "update" | "delete"
    command: string
    using: boolean
    withCheck: boolean
  }[]
> = [
  { template: "read", command: "SELECT", using: true, withCheck: false },
  { template: "insert", command: "INSERT", using: false, withCheck: true },
  { template: "update", command: "UPDATE", using: true, withCheck: true },
  { template: "delete", command: "DELETE", using: true, withCheck: false },
]

async function hardenTable(table: string): Promise<void> {
  await withClient(adminRoleUrl(), async (client) => {
    const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}`
    await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
    await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
    const comparison =
      "(owner = nullif(current_setting('microjbase.user_id', true), '')::uuid)"
    for (const shape of OWNERSHIP_SHAPES) {
      let statement =
        `CREATE POLICY ${quoteIdentifier(ownershipPolicyName(table, "owner", shape.template))} ` +
        `ON ${qualified} FOR ${shape.command} TO PUBLIC`
      if (shape.using) statement += ` USING ${comparison}`
      if (shape.withCheck) statement += ` WITH CHECK ${comparison}`
      await client.query(statement)
    }
  })
}

async function createManagedItemsTable(table: string): Promise<void> {
  await createManagedTable(table, [OWNER_COLUMN])
  await hardenTable(table)
}

async function exposeTable(table: string, alias: string): Promise<void> {
  const outcome = await exposure.expose({
    idempotencyKey: `jdw27-expose-${alias}`,
    actor: "operator",
    schema: APP_SCHEMA,
    table,
    alias,
  })
  expect(outcome.replayed).toBe(false)
}

async function rlsEnabled(table: string): Promise<boolean> {
  return withClient(adminRoleUrl(), async (client) => {
    const result = await client.query<{ relrowsecurity: boolean }>(
      `SELECT c.relrowsecurity FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
      [APP_SCHEMA, table],
    )
    return result.rows[0]?.relrowsecurity === true
  })
}

async function tableExists(table: string): Promise<boolean> {
  return withClient(adminRoleUrl(), async (client) => {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r') AS exists`,
      [APP_SCHEMA, table],
    )
    return result.rows[0]?.exists === true
  })
}

async function dropAdminRole(admin: pg.Client): Promise<void> {
  await admin.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ADMIN_ROLE}') THEN
        EXECUTE 'DROP SCHEMA IF EXISTS ${APP_SCHEMA} CASCADE';
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA microjbase FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA microjbase FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE USAGE ON SCHEMA microjbase FROM "${ADMIN_ROLE}"';
        EXECUTE 'DROP ROLE "${ADMIN_ROLE}"';
      END IF;
    END
    $$;
  `)
}

async function refreshRuntimeRegistry(): Promise<void> {
  const state = await readExposureRegistryState({
    query: (text, values) => adminPool.query(text, values),
  })
  holder.replace(
    await buildTableRegistry(
      { mappings: state.exposed },
      { query: (text, values) => adminPool.query(text, values) },
    ),
  )
}

/**
 * Wrap a pool so the catalogue reader statement blocks until `release` is
 * called: the test can then commit a concurrent operation and prove the
 * locked plan guard (not the friendly preflight) is what fails the command
 * closed in the window between the preflight and the advisory lock.
 */
function catalogueGate(pool: Pool): {
  pool: Pool
  hit: Promise<void>
  release: () => void
} {
  let release!: () => void
  let markHit!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const hit = new Promise<void>((resolve) => {
    markHit = resolve
  })
  return {
    pool: {
      query: (text, values) => {
        if (text.includes("search_path_pin")) {
          markHit()
          return gate.then(() => pool.query(text, values))
        }
        return pool.query(text, values)
      },
      connect: () => pool.connect(),
      close: () => pool.close(),
      async [Symbol.asyncDispose]() {
        await pool.close()
      },
    },
    hit,
    release,
  }
}

beforeAll(async () => {
  await applyMigrationsAndGrants(adminDatabaseUrl as string, RUNTIME_ROLE)

  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'jdw27-%'`,
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
  catalogue = createSchemaCatalogueReader({
    query: (text, values) => adminPool.query(text, values),
  })
  const executor = createSchemaDdlExecutor({
    pool: adminPool,
    createOperationLog: (query) => createSchemaOperationLog({ query }),
  })
  holder = createSwappableTableRegistry(
    await buildTableRegistry({ mappings: [] }, { query: adminPool.query }),
  )
  mutations = createSchemaMutationService({
    pool: adminPool,
    catalogue,
    registry: holder,
    adminRole: ADMIN_ROLE,
    executor,
  })
  rls = createSchemaRlsService({
    pool: adminPool,
    catalogue,
    registry: holder,
    adminRole: ADMIN_ROLE,
    executor,
  })
  policies = createSchemaPolicyService({
    pool: adminPool,
    catalogue,
    adminRole: ADMIN_ROLE,
    runtimeRole: RUNTIME_ROLE,
    executor,
  })
  constraints = createSchemaConstraintService({
    pool: adminPool,
    catalogue,
    adminRole: ADMIN_ROLE,
    executor,
  })
  exposure = createSchemaExposureService({
    pool: adminPool,
    catalogue,
    executor,
    adminRole: ADMIN_ROLE,
    runtimeRole: RUNTIME_ROLE,
    refreshRuntimeRegistry,
  })
})

afterAll(async () => {
  await adminPool.close()
  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await dropAdminRole(admin)
  })
})

describe("locked exposure guard (JDW-27 finding 1)", () => {
  it("refuses to disable row security on an exposed table and leaves RLS on", async () => {
    await createManagedItemsTable("g1_notes")
    await exposeTable("g1_notes", "g1_notes")

    // The in-memory registry now lists the table; the friendly preflight
    // would catch it too, but the authoritative check is the compiled guard
    // that re-reads the durable registry inside the advisory lock.
    await expect(
      rls.disableRowSecurity({
        idempotencyKey: "jdw27-disable-g1",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g1_notes",
        confirm: `${APP_SCHEMA}.g1_notes`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    // The disable rolled back: row security is still enabled and forced.
    expect(await rlsEnabled("g1_notes")).toBe(true)
    await withClient(adminRoleUrl(), async (client) => {
      const result = await client.query<{ relforcerowsecurity: boolean }>(
        `SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
        [APP_SCHEMA, "g1_notes"],
      )
      expect(result.rows[0]?.relforcerowsecurity).toBe(true)
    })
  })

  it("refuses to drop an exposed table and leaves the table present", async () => {
    await createManagedItemsTable("g2_notes")
    await exposeTable("g2_notes", "g2_notes")

    await expect(
      mutations.dropTable({
        idempotencyKey: "jdw27-drop-g2",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g2_notes",
        confirm: `${APP_SCHEMA}.g2_notes`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    expect(await tableExists("g2_notes")).toBe(true)
    expect(await rlsEnabled("g2_notes")).toBe(true)
  })

  it("still allows disabling row security once the table is unexposed", async () => {
    await createManagedItemsTable("g3_notes")
    await exposeTable("g3_notes", "g3_notes")
    await exposure.unexpose({
      idempotencyKey: "jdw27-unexpose-g3",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g3_notes",
    })

    const outcome = await rls.disableRowSecurity({
      idempotencyKey: "jdw27-disable-g3",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g3_notes",
      confirm: `${APP_SCHEMA}.g3_notes`,
    })
    expect(outcome.replayed).toBe(false)
    expect(await rlsEnabled("g3_notes")).toBe(false)
  })

  it("locked guard refuses disableRowSecurity when an expose commits in the preflight window", async () => {
    await createManagedItemsTable("g1s_notes")

    // The gated service reads a registry snapshot that nothing refreshes,
    // modelling a second server process whose in-memory view went stale
    // before its executor reached the advisory lock; the catalogue read is
    // gated so the concurrent expose is guaranteed to commit first.
    const staleHolder = createSwappableTableRegistry(
      await buildTableRegistry({ mappings: [] }, { query: adminPool.query }),
    )
    const gate = catalogueGate(adminPool)
    const gatedCatalogue = createSchemaCatalogueReader({
      query: (text, values) => gate.pool.query(text, values),
    })
    const gatedRls = createSchemaRlsService({
      pool: gate.pool,
      catalogue: gatedCatalogue,
      registry: staleHolder,
      adminRole: ADMIN_ROLE,
      executor: createSchemaDdlExecutor({
        pool: gate.pool,
        createOperationLog: (query) => createSchemaOperationLog({ query }),
      }),
    })

    const pending = gatedRls.disableRowSecurity({
      idempotencyKey: "jdw27-disable-g1s",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g1s_notes",
      confirm: `${APP_SCHEMA}.g1s_notes`,
    })
    try {
      await gate.hit
      await exposeTable("g1s_notes", "g1s_notes")
      gate.release()
      const error = await pending.then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe("CONFLICT")
      expect(await rlsEnabled("g1s_notes")).toBe(true)
      // The failed command rolled back with its history row.
      await withClient(adminDatabaseUrl as string, async (admin) => {
        const result = await admin.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM microjbase.schema_operations
            WHERE idempotency_key = 'jdw27-disable-g1s'`,
        )
        expect(result.rows[0]?.count).toBe("0")
      })
    } finally {
      gate.release()
      await pending.catch(() => undefined)
      await exposure.unexpose({
        idempotencyKey: "jdw27-unexpose-g1s",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g1s_notes",
      })
    }
  })

  it("locked guard refuses dropTable when an expose commits in the preflight window", async () => {
    await createManagedItemsTable("g2s_notes")
    const staleHolder = createSwappableTableRegistry(
      await buildTableRegistry({ mappings: [] }, { query: adminPool.query }),
    )
    const gate = catalogueGate(adminPool)
    const gatedCatalogue = createSchemaCatalogueReader({
      query: (text, values) => gate.pool.query(text, values),
    })
    const gatedMutations = createSchemaMutationService({
      pool: gate.pool,
      catalogue: gatedCatalogue,
      registry: staleHolder,
      adminRole: ADMIN_ROLE,
      executor: createSchemaDdlExecutor({
        pool: gate.pool,
        createOperationLog: (query) => createSchemaOperationLog({ query }),
      }),
    })

    const pending = gatedMutations.dropTable({
      idempotencyKey: "jdw27-drop-g2s",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g2s_notes",
      confirm: `${APP_SCHEMA}.g2s_notes`,
    })
    try {
      await gate.hit
      await exposeTable("g2s_notes", "g2s_notes")
      gate.release()
      const error = await pending.then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe("CONFLICT")
      expect(await tableExists("g2s_notes")).toBe(true)
      expect(await rlsEnabled("g2s_notes")).toBe(true)
    } finally {
      gate.release()
      await pending.catch(() => undefined)
      await exposure.unexpose({
        idempotencyKey: "jdw27-unexpose-g2s",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g2s_notes",
      })
    }
  })
})

describe("expose rejects a broader permissive policy (JDW-27 finding 3)", () => {
  it("rejects a permissive USING (true) policy beside the ownership policies", async () => {
    await createManagedItemsTable("g4_notes")
    // An operator- or attacker-crafted permissive policy applicable to the
    // runtime role would OR with the ownership policy and expose one
    // tenant's rows to another.
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `CREATE POLICY g4_broad_select ON ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g4_notes")} ` +
          `FOR SELECT TO PUBLIC USING (true)`,
      )
    })

    await expect(
      exposure.expose({
        idempotencyKey: "jdw27-expose-g4",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g4_notes",
        alias: "g4_notes",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    // No exposure was recorded and the runtime snapshot stays empty.
    const state = await readExposureRegistryState({
      query: (text, values) => adminPool.query(text, values),
    })
    expect(
      state.exposed.some(
        (entry) => entry.schema === APP_SCHEMA && entry.table === "g4_notes",
      ),
    ).toBe(false)
  })

  it("requires the managed ownership policy for every exercised command", async () => {
    await createManagedTable("g4b_notes", [OWNER_COLUMN])
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g4b_notes")}`
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
    })
    // Only the read template: the runtime role also exercises insert,
    // update, and delete, so the table must not verify.
    await policies.createOwnershipPolicy({
      idempotencyKey: "jdw27-harden-g4b-read",
      actor: "setup",
      schema: APP_SCHEMA,
      table: "g4b_notes",
      column: "owner",
      template: "read",
    })
    await expect(
      exposure.expose({
        idempotencyKey: "jdw27-expose-g4b",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g4b_notes",
        alias: "g4b_notes",
      }),
    ).rejects.toThrow(/no managed insert ownership policy/)
  })

  it("still exposes when a restrictive operator policy narrows the table", async () => {
    await createManagedItemsTable("g4c_notes")
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `CREATE POLICY g4c_restrictive ON ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g4c_notes")} ` +
          `AS RESTRICTIVE FOR ALL TO PUBLIC USING (true)`,
      )
    })
    const outcome = await exposure.expose({
      idempotencyKey: "jdw27-expose-g4c",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g4c_notes",
      alias: "g4c_notes",
    })
    expect(outcome.replayed).toBe(false)
    expect(outcome.record?.status).toBe("succeeded")
    await exposure.unexpose({
      idempotencyKey: "jdw27-unexpose-g4c",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g4c_notes",
    })
  })
})

describe("cascading referential actions refuse exposed tables (JDW-27 finding 4)", () => {
  it("refuses ON DELETE CASCADE when the referenced table is exposed", async () => {
    await createManagedItemsTable("g5_parent")
    await createManagedTable("g5_child", [
      {
        name: "parent_id",
        type: "uuid" as const,
        nullable: true,
        default: { kind: "none" as const },
      },
    ])
    await exposeTable("g5_parent", "g5_parent")

    await expect(
      constraints.addForeignKey({
        idempotencyKey: "jdw27-fk-g5",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g5_child",
        columns: ["parent_id"],
        references: { schema: APP_SCHEMA, table: "g5_parent", columns: ["id"] },
        onUpdate: "no_action",
        onDelete: "cascade",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    // No constraint survived the rollback.
    await withClient(adminRoleUrl(), async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'g5_child' AND con.contype = 'f'`,
        [APP_SCHEMA],
      )
      expect(Number(result.rows[0]?.count ?? "0")).toBe(0)
    })
  })

  it("preserves another tenant's row by refusing the cascade on the exposed side", async () => {
    // Two tenants' rows: Alice's note has a comment, Bob has one too. A
    // cascade from an exposed parent would let Alice's DELETE remove Bob's
    // row; the guard refuses the constraint while either table is exposed.
    await createManagedTable("g6_parent", [OWNER_COLUMN])
    await createManagedTable("g6_child", [
      {
        name: "parent_id",
        type: "uuid" as const,
        nullable: true,
        default: { kind: "none" as const },
      },
    ])

    // Seed before hardening so the owner lane can write arbitrary tenants'
    // rows without satisfying the ownership WITH CHECK policy.
    const alice = "11111111-1111-4111-8111-111111111111"
    const bob = "22222222-2222-4222-8222-222222222222"
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = (t: string): string =>
        `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(t)}`
      await client.query(
        `INSERT INTO ${qualified("g6_parent")} (title, owner) VALUES ('alice note', $1::uuid), ('bob note', $2::uuid)`,
        [alice, bob],
      )
      await client.query(
        `INSERT INTO ${qualified("g6_child")} (title, parent_id)
           SELECT 'alice comment', id FROM ${qualified("g6_parent")} WHERE owner = $1::uuid
           UNION ALL
           SELECT 'bob comment', id FROM ${qualified("g6_parent")} WHERE owner = $2::uuid`,
        [alice, bob],
      )
    })
    await hardenTable("g6_parent")
    await exposeTable("g6_parent", "g6_parent")
    await expect(
      constraints.addForeignKey({
        idempotencyKey: "jdw27-fk-g6",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g6_child",
        columns: ["parent_id"],
        references: { schema: APP_SCHEMA, table: "g6_parent", columns: ["id"] },
        onUpdate: "no_action",
        onDelete: "cascade",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    // Both tenants' child rows survive.
    await withClient(adminRoleUrl(), async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g6_child")}`,
      )
      expect(Number(result.rows[0]?.count ?? "0")).toBe(2)
    })
  })

  it("keeps the action allowlist for tables that are not exposed", async () => {
    await createManagedTable("g7_parent", [OWNER_COLUMN])
    await hardenTable("g7_parent")
    await createManagedTable("g7_child", [
      {
        name: "parent_id",
        type: "uuid" as const,
        nullable: true,
        default: { kind: "none" as const },
      },
    ])

    const outcome = await constraints.addForeignKey({
      idempotencyKey: "jdw27-fk-g7",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g7_child",
      columns: ["parent_id"],
      references: { schema: APP_SCHEMA, table: "g7_parent", columns: ["id"] },
      onUpdate: "no_action",
      onDelete: "cascade",
    })
    expect(outcome.replayed).toBe(false)
  })

  it("refuses SET NULL when the referenced table is exposed", async () => {
    await createManagedTable("g7b_parent", [OWNER_COLUMN])
    await hardenTable("g7b_parent")
    await createManagedTable("g7b_child", [
      {
        name: "parent_id",
        type: "uuid" as const,
        nullable: true,
        default: { kind: "none" as const },
      },
    ])
    await exposeTable("g7b_parent", "g7b_parent")

    await expect(
      constraints.addForeignKey({
        idempotencyKey: "jdw27-fk-g7b",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g7b_child",
        columns: ["parent_id"],
        references: {
          schema: APP_SCHEMA,
          table: "g7b_parent",
          columns: ["id"],
        },
        onUpdate: "no_action",
        onDelete: "set_null",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    await exposure.unexpose({
      idempotencyKey: "jdw27-unexpose-g7b",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g7b_parent",
    })
  })

  it("refuses the action when the referencing table is exposed", async () => {
    await createManagedTable("g7c_target", [OWNER_COLUMN])
    await createManagedTable("g7c_child", [
      OWNER_COLUMN,
      {
        name: "target_id",
        type: "uuid" as const,
        nullable: true,
        default: { kind: "none" as const },
      },
    ])
    await hardenTable("g7c_child")
    await exposeTable("g7c_child", "g7c_child")

    await expect(
      constraints.addForeignKey({
        idempotencyKey: "jdw27-fk-g7c",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g7c_child",
        columns: ["target_id"],
        references: {
          schema: APP_SCHEMA,
          table: "g7c_target",
          columns: ["id"],
        },
        onUpdate: "no_action",
        onDelete: "cascade",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    await exposure.unexpose({
      idempotencyKey: "jdw27-unexpose-g7c",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g7c_child",
    })
  })
})

describe("runtime catalogue probes resist a decoy search_path (JDW-27 finding 5)", () => {
  it("reports the real relrowsecurity despite a forged first search_path entry", async () => {
    const DECOY = "jdw27_decoy"
    // A managed table with row security NOT enabled (relrowsecurity = false).
    await createManagedTable("g8_probe")
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(DECOY)} CASCADE`,
      )
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(DECOY)}`)
      // A forged catalogue: every table appears to have RLS enabled.
      await admin.query(
        `CREATE VIEW ${quoteIdentifier(DECOY)}.pg_namespace AS SELECT oid, nspname FROM pg_catalog.pg_namespace`,
      )
      await admin.query(
        `CREATE VIEW ${quoteIdentifier(DECOY)}.pg_class AS
           SELECT oid, relname, relnamespace, relowner, relkind,
                  true AS relrowsecurity, true AS relforcerowsecurity
             FROM pg_catalog.pg_class`,
      )
    })

    const decoyUrl = new URL(adminDatabaseUrl as string)
    decoyUrl.searchParams.set("options", `-c search_path=${DECOY},pg_catalog`)
    await withClient(decoyUrl.toString(), async (client) => {
      // The forged catalogue really does mislead an unqualified probe.
      const forged = await client.query<{ relrowsecurity: boolean }>(
        `SELECT c.relrowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${quoteLiteral(APP_SCHEMA)} AND c.relname = 'g8_probe' AND c.relkind = 'r'`,
      )
      expect(forged.rows[0]?.relrowsecurity).toBe(true)

      // The qualified probe reports the real value and fails closed.
      await expect(
        checkTableOwnershipAndRls(client, [
          { schema: APP_SCHEMA, table: "g8_probe" },
        ]),
      ).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message: `Row-level security is not enabled on ${APP_SCHEMA}.g8_probe`,
      })

      // The registry builder is likewise decoy-proof.
      await expect(
        buildTableRegistry(
          {
            mappings: [
              { alias: "g8_probe", schema: APP_SCHEMA, table: "g8_probe" },
            ],
          },
          { query: (text, values) => client.query(text, values) },
        ),
      ).rejects.toMatchObject({
        code: "DATABASE_UNAVAILABLE",
        message: `Row-level security is not enabled on ${APP_SCHEMA}.g8_probe`,
      })
    })

    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(DECOY)} CASCADE`,
      )
    })
  })
})

describe("expose replay gate and concurrent alias (JDW-27 lows)", () => {
  it("replay skips the live verification gate and still refreshes the registry", async () => {
    // Prove first that the verification gate is live for a fresh key on an
    // unexposed table: dropping one managed policy makes the table
    // unexposable.
    await createManagedItemsTable("g9_verify")
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `DROP POLICY ${quoteIdentifier(ownershipPolicyName("g9_verify", "owner", "delete"))} ` +
          `ON ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g9_verify")}`,
      )
    })
    await expect(
      exposure.expose({
        idempotencyKey: "jdw27-expose-g9-fresh",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g9_verify",
        alias: "g9_verify",
      }),
    ).rejects.toThrow(/no managed delete ownership policy/)

    // A replay is not a new exposure. Row security that drifts after the
    // recorded success (here disabled directly, the way an operator with
    // database access could) must not send a replayed key back through the
    // live verification gate: the recorded outcome classifies the key and
    // the registry refresh still runs. The refresh is a counting stub so
    // the drifted RLS state cannot fail it; the durable registry row is
    // what the assertions track.
    let stubRefreshes = 0
    const countingExposure = createSchemaExposureService({
      pool: adminPool,
      catalogue,
      executor: createSchemaDdlExecutor({
        pool: adminPool,
        createOperationLog: (query) => createSchemaOperationLog({ query }),
      }),
      adminRole: ADMIN_ROLE,
      runtimeRole: RUNTIME_ROLE,
      refreshRuntimeRegistry: () => {
        stubRefreshes += 1
        return Promise.resolve()
      },
    })
    await createManagedItemsTable("g9_replay")
    await countingExposure.expose({
      idempotencyKey: "jdw27-expose-g9",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g9_replay",
      alias: "g9_replay",
    })
    expect(stubRefreshes).toBe(1)
    try {
      await withClient(adminRoleUrl(), async (client) => {
        await client.query(
          `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g9_replay")} DISABLE ROW LEVEL SECURITY`,
        )
      })

      const replayed = await countingExposure.expose({
        idempotencyKey: "jdw27-expose-g9",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g9_replay",
        alias: "g9_replay",
      })
      expect(replayed.replayed).toBe(true)
      expect(stubRefreshes).toBe(2)
    } finally {
      await countingExposure.unexpose({
        idempotencyKey: "jdw27-unexpose-g9",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g9_replay",
      })
      // Restore the table state for any later rebuild.
      await withClient(adminRoleUrl(), async (client) => {
        await client.query(
          `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g9_replay")} ENABLE ROW LEVEL SECURITY`,
        )
      })
    }
  })

  it("a second concurrent expose conflicts inside the lock instead of renaming the alias", async () => {
    await createManagedItemsTable("g10_race")
    const gate = catalogueGate(adminPool)
    const gatedCatalogue = createSchemaCatalogueReader({
      query: (text, values) => gate.pool.query(text, values),
    })
    const gatedExposure = createSchemaExposureService({
      pool: gate.pool,
      catalogue: gatedCatalogue,
      executor: createSchemaDdlExecutor({
        pool: gate.pool,
        createOperationLog: (query) => createSchemaOperationLog({ query }),
      }),
      adminRole: ADMIN_ROLE,
      runtimeRole: RUNTIME_ROLE,
      refreshRuntimeRegistry,
    })

    const pending = gatedExposure.expose({
      idempotencyKey: "jdw27-expose-g10-a",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g10_race",
      alias: "g10_a",
    })
    try {
      await gate.hit
      // The winner commits alias g10_b while the loser waits in verification.
      const winner = await exposure.expose({
        idempotencyKey: "jdw27-expose-g10-b",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g10_race",
        alias: "g10_b",
      })
      expect(winner.replayed).toBe(false)
      gate.release()
      const error = await pending.then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe("CONFLICT")

      // The public alias is still the winner's; nothing was renamed.
      const row = await findExposureByTarget(
        { query: (text, values) => adminPool.query(text, values) },
        APP_SCHEMA,
        "g10_race",
      )
      expect(row?.exposed).toBe(true)
      expect(row?.alias).toBe("g10_b")
      expect(holder.get("g10_a")).toBeNull()
      expect(holder.get("g10_b")).not.toBeNull()
    } finally {
      gate.release()
      await pending.catch(() => undefined)
      await exposure.unexpose({
        idempotencyKey: "jdw27-unexpose-g10",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g10_race",
      })
    }
  })
})
