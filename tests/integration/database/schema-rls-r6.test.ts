// R6 (JDW-28) integration test: the durable exposure registry — not the
// process-local TableRegistry — is the exposure boundary for RLS disable.
// Two real SwappableTableRegistry holders model two server processes: the
// exposure service refreshes holder B after its commit, holder A never is.
// After the expose commits, a disable routed through the service wired to
// holder A must fail closed with CONFLICT inside the advisory-locked
// transaction, leaving both RLS bits set and the runtime lane unable to see
// any row with an unset microjbase.user_id.
//
// Verification command (PostgreSQL 18.6, workspace-local cluster):
//   INTEGRATION_DATABASE_URL=postgres://microjbase_runtime@127.0.0.1:55432/microjbase_integration_test \
//   INTEGRATION_ADMIN_DATABASE_URL=postgres://microjbase@127.0.0.1:55432/microjbase_integration_test \
//   npx vitest run --project integration tests/integration/database/schema-rls-r6.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"

import type { SchemaCatalogueReader } from "../../../src/contracts/index.js"
import {
  buildTableRegistry,
  createSchemaCatalogueReader,
  createSchemaDdlExecutor,
  createSchemaExposureService,
  createSchemaMutationService,
  createSchemaOperationLog,
  createSchemaPolicyService,
  createSchemaRlsService,
  createSwappableTableRegistry,
  createPool,
  type ManagedColumnSpec,
  type Pool,
  readExposureRegistryState,
  type SchemaExposureService,
  type SchemaMutationService,
  type SchemaPolicyService,
  type SchemaRlsService,
  type SwappableTableRegistry,
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
const ADMIN_ROLE = "mjb_r6_admin"
const ADMIN_ROLE_PASSWORD = "r6_admin_password"
const APP_SCHEMA = "mjb_r6_app"
const ALICE_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"

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
let policies: SchemaPolicyService
/** The live holder: refreshed after every committed exposure change. */
let holderLive: SwappableTableRegistry
/** The stale holder: built once, never refreshed — models a second process. */
let holderStale: SwappableTableRegistry
let rlsLive: SchemaRlsService
let rlsStale: SchemaRlsService

const runtimeQuery = (
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult> => runtimePool.query(text, values)

async function refreshLiveRegistry(): Promise<void> {
  // The verification inside buildTableRegistry is role-aware: it checks
  // pg_has_role(current_user, policy_role) and the runtime role's table
  // privileges, so the refresh must read as the runtime role — the service
  // creates ownership policies TO the runtime role, not to PUBLIC.
  const state = await readExposureRegistryState({ query: runtimeQuery })
  holderLive.replace(
    await buildTableRegistry(
      { mappings: state.exposed },
      { query: runtimeQuery },
    ),
  )
}

async function dropAdminRole(admin: pg.Client): Promise<void> {
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

const TEXT_COLUMN: ManagedColumnSpec = {
  name: "title",
  type: "text",
  nullable: false,
  default: { kind: "none" },
}

const OWNER_COLUMN: ManagedColumnSpec = {
  name: "owner",
  type: "uuid",
  nullable: false,
  default: { kind: "none" },
}

function qualified(table: string): string {
  return `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}`
}

async function createManagedItemsTable(table: string): Promise<void> {
  const outcome = await mutations.createTable({
    idempotencyKey: `r6-setup-${table}`,
    actor: "setup",
    schema: APP_SCHEMA,
    table,
    columns: [TEXT_COLUMN, OWNER_COLUMN],
  })
  expect(outcome.replayed).toBe(false)
}

/** RLS + FORCE + the four module-owned ownership templates, via services. */
async function hardenTable(table: string): Promise<void> {
  const enable = await rlsLive.enableRowSecurity({
    idempotencyKey: `r6-harden-${table}`,
    actor: "operator",
    schema: APP_SCHEMA,
    table,
  })
  expect(enable.replayed).toBe(false)
  for (const template of ["read", "insert", "update", "delete"] as const) {
    const outcome = await policies.createOwnershipPolicy({
      idempotencyKey: `r6-harden-${table}-${template}`,
      actor: "operator",
      schema: APP_SCHEMA,
      table,
      column: "owner",
      template,
    })
    expect(outcome.replayed).toBe(false)
  }
}

async function readCatalogueTable(
  schema: string,
  table: string,
): Promise<{ hasRowSecurity: boolean; hasForcedRowSecurity: boolean }> {
  const snapshot = await catalogue.read()
  const schemaObject = snapshot.schemas.find((entry) => entry.name === schema)
  const found = schemaObject?.tables.find((entry) => entry.name === table)
  if (found === undefined) {
    throw new Error(`table ${schema}.${table} missing from catalogue`)
  }
  return {
    hasRowSecurity: found.hasRowSecurity,
    hasForcedRowSecurity: found.hasForcedRowSecurity,
  }
}

async function operationRecord(
  idempotencyKey: string,
): Promise<{ command_type: string; status: string } | null> {
  const result = await withClient(
    adminDatabaseUrl as string,
    async (client) => {
      const rows = await client.query<{
        command_type: string
        status: string
      }>(
        `SELECT command_type, status FROM microjbase.schema_operations
          WHERE idempotency_key = $1`,
        [idempotencyKey],
      )
      return rows.rows[0] ?? null
    },
  )
  return result
}

/** Run fn on the runtime lane with a transaction-local identity. */
async function withRuntimeIdentity<T>(
  userId: string | null,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(databaseUrl as string, async (client) => {
    await client.query("BEGIN")
    try {
      if (userId !== null) {
        await client.query(
          `SELECT set_config('microjbase.user_id', $1, true)`,
          [userId],
        )
      }
      const result = await fn(client)
      await client.query("COMMIT")
      return result
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
  })
}

async function runtimeList(
  table: string,
  userId: string | null,
): Promise<string[]> {
  return withRuntimeIdentity(userId, async (client) => {
    const result = await client.query<{ title: string }>(
      `SELECT title FROM ${qualified(table)} ORDER BY title`,
    )
    return result.rows.map((row) => row.title)
  })
}

beforeAll(async () => {
  await applyMigrationsAndGrants(adminDatabaseUrl as string, RUNTIME_ROLE)

  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'r6-%'`,
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
  catalogue = createSchemaCatalogueReader({
    query: (text, values) => adminPool.query(text, values),
  })
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
  holderLive = createSwappableTableRegistry(
    await buildTableRegistry({ mappings: [] }, { query: runtimeQuery }),
  )
  holderStale = createSwappableTableRegistry(
    await buildTableRegistry({ mappings: [] }, { query: runtimeQuery }),
  )
  exposure = createSchemaExposureService({
    pool: adminPool,
    catalogue,
    executor,
    adminRole: ADMIN_ROLE,
    runtimeRole: RUNTIME_ROLE,
    refreshRuntimeRegistry: refreshLiveRegistry,
  })
  rlsLive = createSchemaRlsService({
    pool: adminPool,
    catalogue,
    registry: holderLive,
    adminRole: ADMIN_ROLE,
    executor,
  })
  rlsStale = createSchemaRlsService({
    pool: adminPool,
    catalogue,
    registry: holderStale,
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

describe("R6 locked exposure guard (JDW-28)", () => {
  it("refuses disable through a stale second registry and keeps RLS forced", async () => {
    await createManagedItemsTable("staleguard")
    await hardenTable("staleguard")

    const exposeOutcome = await exposure.expose({
      idempotencyKey: "r6-staleguard-expose",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "staleguard",
      alias: "staleguard",
    })
    expect(exposeOutcome.record?.status).toBe("succeeded")

    // The live holder was refreshed by the exposure service; the stale one
    // was never refreshed and still serves the pre-expose snapshot.
    expect(holderLive.get("staleguard")?.table).toBe("staleguard")
    expect(holderStale.get("staleguard")).toBeNull()

    // Seed a row so the unset-identity check below is meaningful.
    await withRuntimeIdentity(ALICE_ID, async (client) => {
      await client.query(
        `INSERT INTO ${qualified("staleguard")} (title, owner) VALUES ('alice row', $1)`,
        [ALICE_ID],
      )
    })
    await expect(runtimeList("staleguard", ALICE_ID)).resolves.toEqual([
      "alice row",
    ])

    // Disable through the service wired to the STALE registry: its
    // registry.list() early gate passes, so only the compiled guard's
    // in-transaction re-read of the durable registry can fail this closed.
    await expect(
      rlsStale.disableRowSecurity({
        idempotencyKey: "r6-staleguard-disable",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "staleguard",
        confirm: `${APP_SCHEMA}.staleguard`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/exposed/),
    })

    // The failed disable left no history and changed nothing: both RLS bits
    // are still set and the runtime lane still fails closed with an unset
    // identity instead of seeing every row.
    await expect(operationRecord("r6-staleguard-disable")).resolves.toBeNull()
    expect(await readCatalogueTable(APP_SCHEMA, "staleguard")).toEqual({
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })
    await expect(runtimeList("staleguard", null)).resolves.toEqual([])
    await expect(runtimeList("staleguard", ALICE_ID)).resolves.toEqual([
      "alice row",
    ])
  })
})
