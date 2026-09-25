// Integration tests for the V02-14..V02-15 row-security state management and
// predefined ownership policy templates against real PostgreSQL:
// fail-closed disable rules, RLS/FORCE state transitions, Alice/Bob
// isolation through the pooled runtime lane, pooled-session identity
// hygiene, policy introspection, and privilege-escalation refusals.

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
  deterministicObjectName,
  type ManagedColumnSpec,
  type Pool,
  type SchemaExposureService,
  type SchemaMutationService,
  type SchemaPolicyService,
  type SchemaRlsService,
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
const ADMIN_ROLE = "mjb_v0215_admin"
const ADMIN_ROLE_PASSWORD = "v0215_admin_password"
const APP_SCHEMA = "mjb_v0215_app"
const ALICE_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
const BOB_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"

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
let rls: SchemaRlsService
let policies: SchemaPolicyService
let holder: ReturnType<typeof createSwappableTableRegistry>

const adminQuery = <R extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<R>> => adminPool.query(text, values)

const runtimeQuery = (
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult> => runtimePool.query(text, values)

async function refreshRuntimeRegistry(): Promise<void> {
  const { readExposureRegistryState } =
    await import("../../../src/database/index.js")
  const state = await readExposureRegistryState({ query: runtimeQuery })
  holder.replace(
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

/** Managed table owned by the schema-admin role; not hardened. */
async function createManagedItemsTable(table: string): Promise<void> {
  const outcome = await mutations.createTable({
    idempotencyKey: `v0215-setup-${table}`,
    actor: "setup",
    schema: APP_SCHEMA,
    table,
    columns: [TEXT_COLUMN, OWNER_COLUMN],
  })
  expect(outcome.replayed).toBe(false)
}

/** Enable RLS + FORCE through the V02-14 command. */
async function enableRls(table: string, key: string): Promise<void> {
  const outcome = await rls.enableRowSecurity({
    idempotencyKey: key,
    actor: "operator",
    schema: APP_SCHEMA,
    table,
  })
  expect(outcome.replayed).toBe(false)
}

async function createTemplate(
  table: string,
  template: "read" | "insert" | "update" | "delete",
  key: string,
): Promise<void> {
  const outcome = await policies.createOwnershipPolicy({
    idempotencyKey: key,
    actor: "operator",
    schema: APP_SCHEMA,
    table,
    column: "owner",
    template,
  })
  expect(outcome.replayed).toBe(false)
}

/** Harden a managed table: RLS + FORCE + all four templates. */
async function hardenTable(table: string): Promise<void> {
  await enableRls(table, `v0215-harden-${table}`)
  for (const template of ["read", "insert", "update", "delete"] as const) {
    await createTemplate(table, template, `v0215-harden-${table}-${template}`)
  }
}

/**
 * Grant the runtime role table-level CRUD the way expose would. Only
 * unexposed test tables use this: it models the least-privilege grant set
 * without involving the durable registry.
 */
async function grantRuntimeCrud(table: string): Promise<void> {
  await withClient(adminRoleUrl(), async (client) => {
    await client.query(
      `GRANT USAGE ON SCHEMA ${quoteIdentifier(APP_SCHEMA)} TO ${quoteIdentifier(RUNTIME_ROLE)}`,
    )
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualified(table)} TO ${quoteIdentifier(RUNTIME_ROLE)}`,
    )
  })
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

interface PolicyRow {
  polname: string
  polcmd: string
  polpermissive: boolean
  roles: string[] | null
  qual: string | null
  withcheck: string | null
}

async function readPolicies(table: string): Promise<PolicyRow[]> {
  const result = await adminQuery<PolicyRow>(
    `SELECT pol.polname,
            pol.polcmd,
            pol.polpermissive,
            (SELECT array_agg(r.rolname::text ORDER BY r.rolname)
               FROM pg_catalog.pg_roles r
              WHERE r.oid = ANY(pol.polroles)) AS roles,
            pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS qual,
            pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS withcheck
       FROM pg_catalog.pg_policy pol
       JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY pol.polname`,
    [APP_SCHEMA, table],
  )
  return result.rows
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

async function runtimeInsert(
  table: string,
  userId: string,
  owner: string,
  title: string,
): Promise<string | { code: string }> {
  return withRuntimeIdentity(userId, async (client) => {
    try {
      const result = await client.query<{ id: string }>(
        `INSERT INTO ${qualified(table)} (title, owner) VALUES ($1, $2) RETURNING id`,
        [title, owner],
      )
      return result.rows[0]?.id ?? "missing"
    } catch (error: unknown) {
      return { code: (error as { code: string }).code }
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

async function runtimeUpdateTitle(
  table: string,
  userId: string,
  targetTitle: string,
): Promise<number | { code: string }> {
  return withRuntimeIdentity(userId, async (client) => {
    try {
      const result = await client.query(
        `UPDATE ${qualified(table)} SET title = $1 || ' (updated)' WHERE title = $1`,
        [targetTitle],
      )
      return result.rowCount ?? 0
    } catch (error: unknown) {
      return { code: (error as { code: string }).code }
    }
  })
}

async function runtimeDeleteTitle(
  table: string,
  userId: string,
  targetTitle: string,
): Promise<number | { code: string }> {
  return withRuntimeIdentity(userId, async (client) => {
    try {
      const result = await client.query(
        `DELETE FROM ${qualified(table)} WHERE title = $1`,
        [targetTitle],
      )
      return result.rowCount ?? 0
    } catch (error: unknown) {
      return { code: (error as { code: string }).code }
    }
  })
}

beforeAll(async () => {
  await applyMigrationsAndGrants(adminDatabaseUrl as string, RUNTIME_ROLE)

  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'v0215-%'`,
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

describe("V02-14 row-security state management", () => {
  it("enables and forces RLS transactionally, records history, and replays", async () => {
    await createManagedItemsTable("state")
    expect(await readCatalogueTable(APP_SCHEMA, "state")).toEqual({
      hasRowSecurity: false,
      hasForcedRowSecurity: false,
    })

    const outcome = await rls.enableRowSecurity({
      idempotencyKey: "v0215-state-enable",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "state",
    })
    expect(outcome.record?.status).toBe("succeeded")
    expect(await readCatalogueTable(APP_SCHEMA, "state")).toEqual({
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })
    await expect(operationRecord("v0215-state-enable")).resolves.toEqual({
      command_type: "schema.rls.enable",
      status: "succeeded",
    })

    // A replayed key returns the recorded outcome without re-executing.
    const replay = await rls.enableRowSecurity({
      idempotencyKey: "v0215-state-enable",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "state",
    })
    expect(replay.replayed).toBe(true)
    expect(await readCatalogueTable(APP_SCHEMA, "state")).toEqual({
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })
  })

  it("fails closed for the runtime lane once RLS is enabled without policies", async () => {
    // "state" is enabled+forced but carries no policies yet: every runtime
    // query matches zero rows instead of seeing the whole table.
    await grantRuntimeCrud("state")
    await expect(runtimeList("state", ALICE_ID)).resolves.toEqual([])
    await expect(runtimeList("state", null)).resolves.toEqual([])
  })

  it("disables RLS only with the exact confirmation on an unexposed table", async () => {
    // Wrong confirmation refuses before any SQL exists.
    await expect(
      rls.disableRowSecurity({
        idempotencyKey: "v0215-state-disable-bad-confirm",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "state",
        confirm: "state",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
    await expect(
      operationRecord("v0215-state-disable-bad-confirm"),
    ).resolves.toBeNull()
    expect(await readCatalogueTable(APP_SCHEMA, "state")).toEqual({
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })

    const outcome = await rls.disableRowSecurity({
      idempotencyKey: "v0215-state-disable",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "state",
      confirm: `${APP_SCHEMA}.state`,
    })
    expect(outcome.record?.status).toBe("succeeded")
    expect(await readCatalogueTable(APP_SCHEMA, "state")).toEqual({
      hasRowSecurity: false,
      hasForcedRowSecurity: false,
    })

    // Re-enable restores both flags for the full lifecycle.
    await rls.enableRowSecurity({
      idempotencyKey: "v0215-state-re-enable",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "state",
    })
    expect(await readCatalogueTable(APP_SCHEMA, "state")).toEqual({
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })
  })

  it("fails closed on internal and non-owned targets", async () => {
    await expect(
      rls.disableRowSecurity({
        idempotencyKey: "v0215-guard-internal",
        actor: "operator",
        schema: "microjbase",
        table: "users",
        confirm: "microjbase.users",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/Internal schemas/),
    })

    // A table owned by the superuser rather than the schema-admin role.
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `CREATE TABLE ${qualified("foreign_owned")} (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL)`,
      )
    })
    await expect(
      rls.disableRowSecurity({
        idempotencyKey: "v0215-guard-foreign",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "foreign_owned",
        confirm: `${APP_SCHEMA}.foreign_owned`,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/owned by the schema-admin role/),
    })
    await expect(
      rls.enableRowSecurity({
        idempotencyKey: "v0215-guard-foreign-enable",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "foreign_owned",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
  })

  it("refuses to disable RLS while the table is exposed, then allows it after unexpose", async () => {
    await createManagedItemsTable("guarded")
    await hardenTable("guarded")

    const exposeOutcome = await exposure.expose({
      idempotencyKey: "v0215-guarded-expose",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "guarded",
      alias: "guarded",
    })
    expect(exposeOutcome.record?.status).toBe("succeeded")
    expect(holder.get("guarded")?.table).toBe("guarded")

    // The durable runtime registry reports the table exposed: disabling row
    // security would expose every user's rows to the pooled lane, so the
    // command fails closed.
    await expect(
      rls.disableRowSecurity({
        idempotencyKey: "v0215-guarded-disable-exposed",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "guarded",
        confirm: `${APP_SCHEMA}.guarded`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/exposed/),
    })
    await expect(
      operationRecord("v0215-guarded-disable-exposed"),
    ).resolves.toBeNull()
    expect(await readCatalogueTable(APP_SCHEMA, "guarded")).toEqual({
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })

    // A dry run with a reused key still runs the exposure guard (D-027).
    await expect(
      rls.disableRowSecurity({
        idempotencyKey: "v0215-guarded-disable-dry",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "guarded",
        confirm: `${APP_SCHEMA}.guarded`,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    const unexposeOutcome = await exposure.unexpose({
      idempotencyKey: "v0215-guarded-unexpose",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "guarded",
    })
    expect(unexposeOutcome.record?.status).toBe("succeeded")
    expect(holder.get("guarded")).toBeNull()

    const disable = await rls.disableRowSecurity({
      idempotencyKey: "v0215-guarded-disable",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "guarded",
      confirm: `${APP_SCHEMA}.guarded`,
    })
    expect(disable.record?.status).toBe("succeeded")
    expect(await readCatalogueTable(APP_SCHEMA, "guarded")).toEqual({
      hasRowSecurity: false,
      hasForcedRowSecurity: false,
    })
  })

  it("rolls a dry run back without history or state change", async () => {
    const outcome = await rls.disableRowSecurity({
      idempotencyKey: "v0215-state-dry-run",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "state",
      confirm: `${APP_SCHEMA}.state`,
      dryRun: true,
    })
    expect(outcome.dryRun).toBe(true)
    expect(outcome.record).toBeNull()
    expect(await readCatalogueTable(APP_SCHEMA, "state")).toEqual({
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })
    await expect(operationRecord("v0215-state-dry-run")).resolves.toBeNull()
  })
})

describe("V02-15 ownership policy templates", () => {
  it("creates all four templates bound to the runtime role with the frozen expression", async () => {
    await createManagedItemsTable("tmpl")
    await enableRls("tmpl", "v0215-tmpl-enable")

    for (const template of ["read", "insert", "update", "delete"] as const) {
      const outcome = await policies.createOwnershipPolicy({
        idempotencyKey: `v0215-tmpl-${template}`,
        actor: "operator",
        schema: APP_SCHEMA,
        table: "tmpl",
        column: "owner",
        template,
      })
      expect(outcome.record?.status).toBe("succeeded")
    }

    const rows = await readPolicies("tmpl")
    const expectedNames = (["delete", "insert", "read", "update"] as const)
      .map((template) => deterministicObjectName(template, "tmpl", ["owner"]))
      .sort()
    expect(rows.map((row) => row.polname)).toEqual(expectedNames)
    for (const row of rows) {
      expect(row.polpermissive).toBe(true)
      expect(row.roles).toEqual([RUNTIME_ROLE])
    }

    const byName = new Map(rows.map((row) => [row.polname, row]))
    const expressionMarkers = [
      "NULLIF(current_setting('microjbase.user_id'",
      "::uuid",
    ]

    const read = byName.get(deterministicObjectName("read", "tmpl", ["owner"]))
    expect(read?.polcmd).toBe("r")
    expect(read?.qual ?? "").toContain("(owner = ")
    for (const marker of expressionMarkers) {
      expect(read?.qual ?? "").toContain(marker)
    }
    expect(read?.withcheck).toBeNull()

    const insert = byName.get(
      deterministicObjectName("insert", "tmpl", ["owner"]),
    )
    expect(insert?.polcmd).toBe("a")
    expect(insert?.qual).toBeNull()
    expect(insert?.withcheck ?? "").toContain("(owner = ")
    for (const marker of expressionMarkers) {
      expect(insert?.withcheck ?? "").toContain(marker)
    }

    const update = byName.get(
      deterministicObjectName("update", "tmpl", ["owner"]),
    )
    expect(update?.polcmd).toBe("w")
    expect(update?.qual ?? "").toContain("(owner = ")
    expect(update?.withcheck ?? "").toContain("(owner = ")

    const del = byName.get(deterministicObjectName("delete", "tmpl", ["owner"]))
    expect(del?.polcmd).toBe("d")
    expect(del?.qual ?? "").toContain("(owner = ")
    expect(del?.withcheck).toBeNull()

    // A fresh key for an existing module-created policy refuses, and a dry
    // run writes nothing.
    await expect(
      policies.createOwnershipPolicy({
        idempotencyKey: "v0215-tmpl-read-dup",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "tmpl",
        column: "owner",
        template: "read",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/already exists/),
    })
    await createManagedItemsTable("tmpldry")
    const dryRun = await policies.createOwnershipPolicy({
      idempotencyKey: "v0215-tmpl-read-dry",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "tmpldry",
      column: "owner",
      template: "read",
      dryRun: true,
    })
    expect(dryRun.dryRun).toBe(true)
    await expect(operationRecord("v0215-tmpl-read-dry")).resolves.toBeNull()

    // Replaying the recorded create returns the outcome without re-executing.
    const replay = await policies.createOwnershipPolicy({
      idempotencyKey: "v0215-tmpl-read",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "tmpl",
      column: "owner",
      template: "read",
    })
    expect(replay.replayed).toBe(true)
    expect(await readPolicies("tmpl")).toHaveLength(4)
  })

  it("refuses ownership columns that are missing, non-uuid, generated, or identity", async () => {
    await mutations.createTable({
      idempotencyKey: "v0215-setup-columns",
      actor: "setup",
      schema: APP_SCHEMA,
      table: "columns",
      columns: [
        TEXT_COLUMN,
        {
          name: "owner",
          type: "text",
          nullable: false,
          default: { kind: "none" },
        },
      ],
    })
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `ALTER TABLE ${qualified("columns")} ADD COLUMN generated_owner TEXT GENERATED ALWAYS AS ('generated') STORED`,
      )
      await client.query(
        `ALTER TABLE ${qualified("columns")} ADD COLUMN identity_owner BIGINT GENERATED BY DEFAULT AS IDENTITY`,
      )
    })

    const cases: ReadonlyArray<{
      column: string
      key: string
      code: string
      message: RegExp
    }> = [
      {
        column: "owner",
        key: "v0215-columns-text",
        code: "VALIDATION_ERROR",
        message: /type uuid/,
      },
      {
        column: "generated_owner",
        key: "v0215-columns-generated",
        code: "VALIDATION_ERROR",
        message: /Generated and identity/,
      },
      {
        column: "identity_owner",
        key: "v0215-columns-identity",
        code: "VALIDATION_ERROR",
        message: /Generated and identity/,
      },
      {
        column: "missing",
        key: "v0215-columns-missing",
        code: "TABLE_NOT_FOUND",
        message: /does not exist/,
      },
    ]
    for (const { column, key, code, message } of cases) {
      await expect(
        policies.createOwnershipPolicy({
          idempotencyKey: key,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "columns",
          column,
          template: "read",
        }),
      ).rejects.toMatchObject({ code, message: expect.stringMatching(message) })
      await expect(operationRecord(key)).resolves.toBeNull()
    }
    expect(await readPolicies("columns")).toHaveLength(0)
  })
})

describe("Alice/Bob isolation through the runtime lane", () => {
  it("keeps rows isolated across users for read, update, and delete", async () => {
    await createManagedItemsTable("iso")
    await hardenTable("iso")
    await grantRuntimeCrud("iso")

    const aliceRow = await runtimeInsert("iso", ALICE_ID, ALICE_ID, "alice row")
    expect(aliceRow).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    const bobRow = await runtimeInsert("iso", BOB_ID, BOB_ID, "bob row")
    expect(typeof bobRow).toBe("string")

    // Neither user can see the other's rows.
    await expect(runtimeList("iso", ALICE_ID)).resolves.toEqual(["alice row"])
    await expect(runtimeList("iso", BOB_ID)).resolves.toEqual(["bob row"])

    // Bob cannot update or delete Alice's row (USING filters the target).
    await expect(runtimeUpdateTitle("iso", BOB_ID, "alice row")).resolves.toBe(
      0,
    )
    await expect(runtimeDeleteTitle("iso", BOB_ID, "alice row")).resolves.toBe(
      0,
    )
    await expect(runtimeList("iso", ALICE_ID)).resolves.toEqual(["alice row"])

    // Bob cannot claim Alice's row on insert (WITH CHECK rejects the write).
    const forged = await runtimeInsert("iso", BOB_ID, ALICE_ID, "forged row")
    expect(forged).toEqual({ code: "42501" })
    await expect(runtimeList("iso", ALICE_ID)).resolves.toEqual(["alice row"])

    // Bob's own write path stays intact end to end.
    await expect(runtimeUpdateTitle("iso", BOB_ID, "bob row")).resolves.toBe(1)
    await expect(runtimeList("iso", BOB_ID)).resolves.toEqual([
      "bob row (updated)",
    ])
  })

  it("never leaks identity between pooled sessions", async () => {
    const alice = await runtimePool.connect()
    const bob = await runtimePool.connect()
    try {
      await alice.query("BEGIN")
      await alice.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        ALICE_ID,
      ])
      await alice.query(
        `INSERT INTO ${qualified("iso")} (title, owner) VALUES ('pooled alice', $1)`,
        [ALICE_ID],
      )

      // Bob, on a different pooled connection and while Alice's transaction
      // is still open, sees only his own rows — never Alice's.
      await bob.query("BEGIN")
      await bob.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        BOB_ID,
      ])
      const during = await bob.query<{ title: string }>(
        `SELECT title FROM ${qualified("iso")}`,
      )
      expect(during.rows.map((row) => row.title)).toEqual(["bob row (updated)"])
      await bob.query("COMMIT")

      await alice.query("COMMIT")

      // After Alice commits, Bob still sees nothing of her rows.
      await bob.query("BEGIN")
      await bob.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        BOB_ID,
      ])
      const after = await bob.query<{ title: string }>(
        `SELECT title FROM ${qualified("iso")}`,
      )
      expect(after.rows.map((row) => row.title)).toEqual(["bob row (updated)"])
      await bob.query("COMMIT")

      // Alice re-checking on her pooled connection sees exactly her rows.
      await alice.query("BEGIN")
      await alice.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        ALICE_ID,
      ])
      const aliceRows = await alice.query<{ title: string }>(
        `SELECT title FROM ${qualified("iso")} ORDER BY title`,
      )
      expect(aliceRows.rows.map((row) => row.title)).toEqual([
        "alice row",
        "pooled alice",
      ])
      await alice.query("COMMIT")
    } finally {
      alice.release()
      bob.release()
    }
  })

  it("fails closed on a pooled session whose transaction carries no identity", async () => {
    const client = await runtimePool.connect()
    try {
      // The identity is transaction-local: once Alice's transaction commits,
      // the same pooled session must not retain it.
      await client.query("BEGIN")
      await client.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        ALICE_ID,
      ])
      const withIdentity = await client.query(
        `SELECT title FROM ${qualified("iso")}`,
      )
      expect(withIdentity.rows).toHaveLength(2)
      await client.query("COMMIT")

      await client.query("BEGIN")
      const withoutIdentity = await client.query(
        `SELECT title FROM ${qualified("iso")}`,
      )
      expect(withoutIdentity.rows).toHaveLength(0)
      await client.query("COMMIT")
    } finally {
      client.release()
    }
  })

  it("applies FORCE RLS to the table owner as well as the runtime lane", async () => {
    // The hardened table's policies apply TO the runtime role only, so even
    // the table owner (connecting through the admin lane) matches no policy
    // and fails closed while FORCE RLS is on.
    await withClient(adminRoleUrl(), async (client) => {
      const noIdentity = await client.query(
        `SELECT title FROM ${qualified("iso")}`,
      )
      expect(noIdentity.rows).toHaveLength(0)
      await client.query(`SELECT set_config('microjbase.user_id', $1, true)`, [
        ALICE_ID,
      ])
      const withIdentity = await client.query(
        `SELECT title FROM ${qualified("iso")}`,
      )
      expect(withIdentity.rows).toHaveLength(0)
    })
  })
})

describe("privilege escalation", () => {
  it("denies the runtime role direct RLS and policy management", async () => {
    await createManagedItemsTable("escalation")
    await hardenTable("escalation")

    const attempts: ReadonlyArray<{ sql: string; key: string }> = [
      {
        sql: `CREATE POLICY hack ON ${qualified("escalation")} FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
        key: "policy",
      },
      {
        sql: `DROP POLICY ${deterministicObjectName("read", "escalation", ["owner"])} ON ${qualified("escalation")}`,
        key: "drop-policy",
      },
      {
        sql: `ALTER TABLE ${qualified("escalation")} DISABLE ROW LEVEL SECURITY`,
        key: "disable-rls",
      },
      {
        sql: `ALTER TABLE ${qualified("escalation")} NO FORCE ROW LEVEL SECURITY`,
        key: "no-force",
      },
    ]
    for (const { sql, key } of attempts) {
      const outcome = await withRuntimeIdentity(ALICE_ID, async (client) => {
        try {
          await client.query(sql)
          return null
        } catch (error: unknown) {
          return { code: (error as { code: string }).code }
        }
      })
      expect(outcome, key).toEqual({ code: "42501" })
    }

    // The table is unchanged: RLS stays enabled and forced, the module
    // policy set is intact.
    expect(await readCatalogueTable(APP_SCHEMA, "escalation")).toEqual({
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })
    expect(
      (await readPolicies("escalation")).map((row) => row.polname),
    ).toEqual(
      (["delete", "insert", "read", "update"] as const)
        .map((template) =>
          deterministicObjectName(template, "escalation", ["owner"]),
        )
        .sort(),
    )
  })

  it("keeps the runtime role unable to read the admin operation log", async () => {
    const outcome = await withRuntimeIdentity(ALICE_ID, async (client) => {
      try {
        await client.query(`SELECT count(*) FROM microjbase.schema_operations`)
        return null
      } catch (error: unknown) {
        return { code: (error as { code: string }).code }
      }
    })
    expect(outcome).toEqual({ code: "42501" })
  })
})

describe("policy removal semantics", () => {
  it("removes only the named module-created policy and never reconstructs others", async () => {
    await createManagedItemsTable("removals")
    await hardenTable("removals")
    await grantRuntimeCrud("removals")

    // An operator-authored policy predating the templates (v0.1 style).
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `CREATE POLICY custom_all ON ${qualified("removals")} FOR ALL TO PUBLIC
           USING (owner = nullif(current_setting('microjbase.user_id', true), '')::uuid)
           WITH CHECK (owner = nullif(current_setting('microjbase.user_id', true), '')::uuid)`,
      )
    })

    const remove = await policies.removeOwnershipPolicy({
      idempotencyKey: "v0215-removals-remove-read",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "removals",
      column: "owner",
      template: "read",
    })
    expect(remove.record?.status).toBe("succeeded")

    const remaining = (await readPolicies("removals")).map((row) => row.polname)
    expect(remaining).toEqual(
      [
        "custom_all",
        ...(["delete", "insert", "update"] as const).map((template) =>
          deterministicObjectName(template, "removals", ["owner"]),
        ),
      ].sort(),
    )

    // Removing the same module-created policy again with a fresh key refuses.
    await expect(
      policies.removeOwnershipPolicy({
        idempotencyKey: "v0215-removals-remove-read-again",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "removals",
        column: "owner",
        template: "read",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/does not exist/),
    })

    // The custom operator policy is byte-identical after the removal: the
    // command never restores or reconstructs arbitrary expressions.
    const custom = (await readPolicies("removals")).find(
      (row) => row.polname === "custom_all",
    )
    expect(custom?.roles).toBeNull()
    expect(custom?.qual ?? "").toContain("(owner = ")

    // With the read template gone, the runtime lane still reads through the
    // operator's own policy: Alice sees her row, Bob does not, and Bob
    // cannot claim Alice's row.
    const inserted = await runtimeInsert("removals", ALICE_ID, ALICE_ID, "row1")
    expect(typeof inserted).toBe("string")
    await expect(runtimeList("removals", ALICE_ID)).resolves.toEqual(["row1"])
    await expect(runtimeList("removals", BOB_ID)).resolves.toEqual([])
    const forged = await runtimeInsert("removals", BOB_ID, ALICE_ID, "forged")
    expect(forged).toEqual({ code: "42501" })

    // Removing every module template leaves the operator policy untouched
    // and the runtime lane fully functional through it.
    for (const template of ["insert", "update", "delete"] as const) {
      const outcome = await policies.removeOwnershipPolicy({
        idempotencyKey: `v0215-removals-remove-${template}`,
        actor: "operator",
        schema: APP_SCHEMA,
        table: "removals",
        column: "owner",
        template,
      })
      expect(outcome.record?.status).toBe("succeeded")
    }
    expect((await readPolicies("removals")).map((row) => row.polname)).toEqual([
      "custom_all",
    ])
    await expect(runtimeList("removals", ALICE_ID)).resolves.toEqual(["row1"])

    // The operator drops the custom policy directly; with no applicable
    // policy left, the runtime lane fails closed.
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(`DROP POLICY custom_all ON ${qualified("removals")}`)
    })
    await expect(runtimeList("removals", ALICE_ID)).resolves.toEqual([])

    // Recreating the read template restores exactly the operator's own rows.
    const recreate = await policies.createOwnershipPolicy({
      idempotencyKey: "v0215-removals-recreate-read",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "removals",
      column: "owner",
      template: "read",
    })
    expect(recreate.record?.status).toBe("succeeded")
    await expect(runtimeList("removals", ALICE_ID)).resolves.toEqual(["row1"])
  })
})
