// Integration tests for the V02-07..V02-09 typed mutation commands against
// real PostgreSQL: managed table lifecycle, column lifecycle, defaults,
// nullability preflight, the frozen conversion matrix, exposure/ownership
// guards, exact confirmations, idempotency replay, history records, and
// transactional rollback.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type {
  ExposedTable,
  SchemaCatalogueReader,
  SchemaCatalogueTable,
} from "../../../src/contracts/index.js"
import {
  createSchemaCatalogueReader,
  createSchemaDdlExecutor,
  createSchemaMutationService,
  createSchemaOperationLog,
  createPool,
  type Pool,
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

const ADMIN_ROLE = "mjb_v0207_admin"
const ADMIN_ROLE_PASSWORD = "v0207_admin_password"
const APP_SCHEMA = "mjb_v0207_app"

function adminRoleUrl(): string {
  const url = new URL(adminDatabaseUrl as string)
  url.username = ADMIN_ROLE
  url.password = ADMIN_ROLE_PASSWORD
  return url.toString()
}

let adminPool: Pool
let catalogue: SchemaCatalogueReader
let service: SchemaMutationService
const exposedTables: ExposedTable[] = []

const registry = {
  get: (alias: string) =>
    exposedTables.find((entry) => entry.alias === alias) ?? null,
  list: () => exposedTables,
}

function expose(schema: string, table: string): void {
  exposedTables.push({
    alias: table,
    schema,
    table,
    primaryKey: "id",
    readableColumns: ["id"],
    insertableColumns: ["id"],
    updatableColumns: ["id"],
  })
}

function unexposeAll(): void {
  exposedTables.length = 0
}

const TEXT_COLUMN = {
  name: "title",
  type: "text" as const,
  nullable: false,
  default: { kind: "none" as const },
}

async function createManagedTable(
  table: string,
  extraColumns: readonly (typeof TEXT_COLUMN)[] = [],
): Promise<void> {
  const outcome = await service.createTable({
    idempotencyKey: `v0207-setup-${table}`,
    actor: "setup",
    schema: APP_SCHEMA,
    table,
    columns: [TEXT_COLUMN, ...extraColumns],
  })
  expect(outcome.replayed).toBe(false)
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  return withClient(adminDatabaseUrl as string, async (admin) => {
    const result = await admin.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
       ) AS exists`,
      [schema, table],
    )
    return result.rows[0]?.exists === true
  })
}

async function tableOwner(
  schema: string,
  table: string,
): Promise<string | null> {
  return withClient(adminDatabaseUrl as string, async (admin) => {
    const result = await admin.query<{ owner: string }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
      [schema, table],
    )
    return result.rows[0]?.owner ?? null
  })
}

async function historyRow(
  key: string,
): Promise<Record<string, unknown> | null> {
  return withClient(adminDatabaseUrl as string, async (admin) => {
    const result = await admin.query(
      `SELECT status, error_code, result FROM microjbase.schema_operations WHERE idempotency_key = $1`,
      [key],
    )
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null
  })
}

async function readCatalogueTable(
  schema: string,
  table: string,
): Promise<SchemaCatalogueTable | null> {
  const snapshot = await catalogue.read()
  const schemaObject = snapshot.schemas.find((entry) => entry.name === schema)
  return schemaObject?.tables.find((entry) => entry.name === table) ?? null
}

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withClient(adminRoleUrl(), async (client) => {
    const keys = Object.keys(values)
    const statement =
      keys.length === 0
        ? `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)} DEFAULT VALUES RETURNING *`
        : `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)} (${keys
            .map(quoteIdentifier)
            .join(", ")})
           VALUES (${keys.map((_, index) => `$${String(index + 1)}`).join(", ")})
           RETURNING *`
    const result = await client.query(
      statement,
      keys.map((key) => values[key] as never),
    )
    return result.rows[0] as Record<string, unknown>
  })
}

async function selectValues(table: string, column: string): Promise<unknown[]> {
  return withClient(adminRoleUrl(), async (client) => {
    const result = await client.query(
      `SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(column)} NULLS FIRST`,
    )
    return result.rows.map((row) => (row as { value: unknown }).value)
  })
}

beforeAll(async () => {
  await applyMigrationsAndGrants(
    adminDatabaseUrl as string,
    new URL(databaseUrl as string).username,
  )

  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'v0207-%'`,
    )
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(ADMIN_ROLE)}`)
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
    // The locked exposure guard compiled into every structural mutation reads
    // the durable registry, so the admin role needs SELECT on it.
    await admin.query(
      `GRANT SELECT ON microjbase.exposure_registry TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
  })

  adminPool = createPool({ databaseUrl: adminRoleUrl(), maxConnections: 5 })
  catalogue = createSchemaCatalogueReader({
    query: (text, values) => adminPool.query(text, values),
  })
  const executor = createSchemaDdlExecutor({
    pool: adminPool,
    createOperationLog: (query) => createSchemaOperationLog({ query }),
  })
  service = createSchemaMutationService({
    pool: adminPool,
    catalogue,
    registry,
    adminRole: ADMIN_ROLE,
    executor,
  })
})

afterAll(async () => {
  unexposeAll()
  await adminPool.close()
  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await admin.query(
      `REVOKE ALL ON microjbase.schema_operations FROM ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `REVOKE ALL ON SEQUENCE microjbase.schema_operations_id_seq FROM ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `REVOKE ALL ON microjbase.exposure_registry FROM ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `REVOKE USAGE ON SCHEMA microjbase FROM ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(ADMIN_ROLE)}`)
  })
})

describe("V02-07 table lifecycle against real PostgreSQL", () => {
  it("creates a managed table with a UUID id primary key owned by the admin role", async () => {
    const outcome = await service.createTable({
      idempotencyKey: "v0207-create-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      columns: [TEXT_COLUMN],
    })
    expect(outcome.replayed).toBe(false)
    expect(outcome.record?.status).toBe("succeeded")
    expect(outcome.record?.commandType).toBe("schema.table.create")

    const catalogued = await readCatalogueTable(APP_SCHEMA, "notes")
    expect(catalogued).not.toBeNull()
    expect(catalogued?.owner).toBe(ADMIN_ROLE)
    const idColumn = catalogued?.columns.find((entry) => entry.name === "id")
    expect(idColumn?.type.name).toBe("uuid")
    expect(idColumn?.isNullable).toBe(false)
    expect(idColumn?.defaultExpression).toContain("gen_random_uuid()")
    expect(catalogued?.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "primary_key",
          columns: ["id"],
        }),
      ]),
    )

    // The managed default actually generates UUIDs.
    const inserted = await insertRow("notes", { title: "first" })
    expect(inserted["id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    const history = await historyRow("v0207-create-1")
    expect(history?.status).toBe("succeeded")
  })

  it("refuses reserved, internal, missing-schema, and duplicate targets before executing", async () => {
    const cases: readonly (readonly [string, string, string, number])[] = [
      ["microjbase", "secret_notes", "VALIDATION_ERROR", 400],
      ["PG_catalog", "secret_notes", "VALIDATION_ERROR", 400],
      ["missing_schema", "notes", "TABLE_NOT_FOUND", 404],
      [APP_SCHEMA, "notes", "CONFLICT", 409],
      [APP_SCHEMA, "pg_stat_notes", "VALIDATION_ERROR", 400],
    ]
    for (const [index, [schema, table, code, status]] of cases.entries()) {
      const error = await service
        .createTable({
          idempotencyKey: `v0207-create-refuse-${String(index)}`,
          actor: "operator",
          schema,
          table,
          columns: [TEXT_COLUMN],
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        )
      expect(error).toMatchObject({ code, status })
    }
    // None of the refused commands touched the executor or history.
    for (let index = 0; index < cases.length; index += 1) {
      expect(
        await historyRow(`v0207-create-refuse-${String(index)}`),
      ).toBeNull()
    }
    expect(await tableExists(APP_SCHEMA, "pg_stat_notes")).toBe(false)
  })

  it("refuses operator columns named id in any case and empty column lists", async () => {
    for (const [index, name] of ["id", "ID"].entries()) {
      const error = await service
        .createTable({
          idempotencyKey: `v0207-create-id-${String(index)}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: `idcase_${String(index)}`,
          columns: [{ ...TEXT_COLUMN, name }],
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        )
      expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    }
    const empty = await service
      .createTable({
        idempotencyKey: "v0207-create-empty",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "empty_notes",
        columns: [],
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(empty).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
  })

  it("dry-run rolls back without a table or a history row", async () => {
    const outcome = await service.createTable({
      idempotencyKey: "v0207-create-dry",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "dry_notes",
      columns: [TEXT_COLUMN],
      dryRun: true,
    })
    expect(outcome.dryRun).toBe(true)
    expect(await tableExists(APP_SCHEMA, "dry_notes")).toBe(false)
    expect(await historyRow("v0207-create-dry")).toBeNull()
  })

  it("replays an identical key without re-executing and conflicts on a different command", async () => {
    await createManagedTable("replay_notes")
    const replay = await service.createTable({
      idempotencyKey: "v0207-setup-replay_notes",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "replay_notes",
      columns: [TEXT_COLUMN],
    })
    expect(replay.replayed).toBe(true)
    expect(replay.record?.status).toBe("succeeded")

    const conflict = await service
      .createTable({
        idempotencyKey: "v0207-setup-replay_notes",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "replay_notes",
        columns: [{ ...TEXT_COLUMN, name: "body" }],
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(conflict).toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("renames a table and records the operation", async () => {
    await createManagedTable("rename_me")
    const outcome = await service.renameTable({
      idempotencyKey: "v0207-rename-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "rename_me",
      newName: "renamed_notes",
    })
    expect(outcome.replayed).toBe(false)
    expect(await tableExists(APP_SCHEMA, "rename_me")).toBe(false)
    expect(await tableExists(APP_SCHEMA, "renamed_notes")).toBe(true)
    expect(await tableOwner(APP_SCHEMA, "renamed_notes")).toBe(ADMIN_ROLE)
    expect((await historyRow("v0207-rename-1"))?.status).toBe("succeeded")

    const conflict = await service
      .renameTable({
        idempotencyKey: "v0207-rename-2",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "renamed_notes",
        newName: "notes",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(conflict).toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("refuses to rename an exposed table until it is unexposed", async () => {
    await createManagedTable("exposed_rename")
    expose(APP_SCHEMA, "exposed_rename")
    try {
      const exposed = await service
        .renameTable({
          idempotencyKey: "v0207-rename-exposed",
          actor: "operator",
          schema: APP_SCHEMA,
          table: "exposed_rename",
          newName: "exposed_renamed",
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        )
      expect(exposed).toMatchObject({ code: "CONFLICT", status: 409 })
      expect(await tableExists(APP_SCHEMA, "exposed_rename")).toBe(true)

      unexposeAll()
      const outcome = await service.renameTable({
        idempotencyKey: "v0207-rename-after-unexpose",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "exposed_rename",
        newName: "exposed_renamed",
      })
      expect(outcome.replayed).toBe(false)
      expect(await tableExists(APP_SCHEMA, "exposed_renamed")).toBe(true)
    } finally {
      unexposeAll()
    }
  })

  it("refuses to mutate a table owned by another role", async () => {
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `CREATE TABLE ${quoteIdentifier(APP_SCHEMA)}.foreign_owned (id uuid)`,
      )
    })
    const rename = await service
      .renameTable({
        idempotencyKey: "v0207-foreign-rename",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "foreign_owned",
        newName: "foreign_owned2",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(rename).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    const drop = await service
      .dropTable({
        idempotencyKey: "v0207-foreign-drop",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "foreign_owned",
        confirm: `${APP_SCHEMA}.foreign_owned`,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(drop).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(await tableExists(APP_SCHEMA, "foreign_owned")).toBe(true)
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `DROP TABLE ${quoteIdentifier(APP_SCHEMA)}.foreign_owned`,
      )
    })
  })

  it("drops a table with the exact confirmation and refuses anything else", async () => {
    await createManagedTable("drop_me")
    const wrong = await service
      .dropTable({
        idempotencyKey: "v0207-drop-wrong",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "drop_me",
        confirm: "drop_me",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(wrong).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(await tableExists(APP_SCHEMA, "drop_me")).toBe(true)
    expect(await historyRow("v0207-drop-wrong")).toBeNull()

    const outcome = await service.dropTable({
      idempotencyKey: "v0207-drop-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "drop_me",
      confirm: `${APP_SCHEMA}.drop_me`,
    })
    expect(outcome.replayed).toBe(false)
    expect(await tableExists(APP_SCHEMA, "drop_me")).toBe(false)
    expect((await historyRow("v0207-drop-1"))?.status).toBe("succeeded")
  })

  it("refuses to drop a table referenced by foreign keys and preserves the child data", async () => {
    await createManagedTable("fk_parent")
    await createManagedTable("fk_child")
    await service.addColumn({
      idempotencyKey: "v0207-child-parent-ref",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "fk_child",
      column: {
        name: "parent_ref",
        type: "uuid",
        nullable: true,
        default: { kind: "none" },
      },
    })
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.fk_child
           ADD CONSTRAINT fk_child_parent_ref_fkey
           FOREIGN KEY (parent_ref) REFERENCES ${quoteIdentifier(APP_SCHEMA)}.fk_parent (id)`,
      )
    })
    const parent = await insertRow("fk_parent", { title: "parent row" })
    await insertRow("fk_child", {
      title: "child row",
      parent_ref: parent["id"],
    })

    const error = await service
      .dropTable({
        idempotencyKey: "v0207-drop-referenced",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "fk_parent",
        confirm: `${APP_SCHEMA}.fk_parent`,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).toMatchObject({ code: "CONFLICT", status: 409 })
    expect(await tableExists(APP_SCHEMA, "fk_parent")).toBe(true)
    expect(await selectValues("fk_child", "title")).toEqual(["child row"])
  })

  it("rolls back a failed drop transactionally and allows an idempotent retry", async () => {
    await createManagedTable("rollback_me")
    await insertRow("rollback_me", { title: "keep me" })

    // A dependent view is outside the catalogue contract, so the preflight
    // dependency check cannot see it; PostgreSQL itself must refuse the
    // DROP TABLE inside the transaction and the executor rolls everything
    // back, leaving neither the drop nor a history row behind.
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `CREATE VIEW ${quoteIdentifier(APP_SCHEMA)}.rollback_me_view AS
           SELECT id FROM ${quoteIdentifier(APP_SCHEMA)}.rollback_me`,
      )
    })

    const failure = await service
      .dropTable({
        idempotencyKey: "v0207-drop-rollback",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "rollback_me",
        confirm: `${APP_SCHEMA}.rollback_me`,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(failure).toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    })
    expect(await tableExists(APP_SCHEMA, "rollback_me")).toBe(true)
    expect(await historyRow("v0207-drop-rollback")).toBeNull()
    expect(await selectValues("rollback_me", "title")).toEqual(["keep me"])

    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `DROP VIEW ${quoteIdentifier(APP_SCHEMA)}.rollback_me_view`,
      )
    })
    const retry = await service.dropTable({
      idempotencyKey: "v0207-drop-rollback",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "rollback_me",
      confirm: `${APP_SCHEMA}.rollback_me`,
    })
    expect(retry.replayed).toBe(false)
    expect(await tableExists(APP_SCHEMA, "rollback_me")).toBe(false)
    expect((await historyRow("v0207-drop-rollback"))?.status).toBe("succeeded")
  })
})

describe("V02-08 column lifecycle against real PostgreSQL", () => {
  it("adds a column with a default and backfills existing rows", async () => {
    await createManagedTable("backfill_me")
    await insertRow("backfill_me", { title: "existing" })

    const outcome = await service.addColumn({
      idempotencyKey: "v0207-add-backfill",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "backfill_me",
      column: {
        name: "status",
        type: "text",
        nullable: false,
        default: { kind: "literal", value: "open" },
      },
    })
    expect(outcome.replayed).toBe(false)
    expect(await selectValues("backfill_me", "status")).toEqual(["open"])

    const catalogued = await readCatalogueTable(APP_SCHEMA, "backfill_me")
    expect(
      catalogued?.columns.find((entry) => entry.name === "status"),
    ).toMatchObject({ isNullable: false, defaultExpression: "'open'::text" })
  })

  it("refuses NOT NULL without a default on a populated table and leaves it unchanged", async () => {
    await createManagedTable("populated_notes")
    await insertRow("populated_notes", { title: "row" })

    const error = await service
      .addColumn({
        idempotencyKey: "v0207-add-notnull",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "populated_notes",
        column: {
          name: "priority",
          type: "integer",
          nullable: false,
          default: { kind: "none" },
        },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const catalogued = await readCatalogueTable(APP_SCHEMA, "populated_notes")
    expect(catalogued?.columns.some((entry) => entry.name === "priority")).toBe(
      false,
    )
  })

  it("adds a NOT NULL column without a default to an empty table", async () => {
    await createManagedTable("empty_for_add")
    const outcome = await service.addColumn({
      idempotencyKey: "v0207-add-empty",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "empty_for_add",
      column: {
        name: "priority",
        type: "integer",
        nullable: false,
        default: { kind: "none" },
      },
    })
    expect(outcome.replayed).toBe(false)
    const catalogued = await readCatalogueTable(APP_SCHEMA, "empty_for_add")
    expect(
      catalogued?.columns.find((entry) => entry.name === "priority"),
    ).toMatchObject({ isNullable: false })
  })

  it("refuses duplicate columns and the managed id name", async () => {
    await createManagedTable("dup_notes")
    const duplicate = await service
      .addColumn({
        idempotencyKey: "v0207-add-dup",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "dup_notes",
        column: {
          name: "title",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(duplicate).toMatchObject({ code: "CONFLICT", status: 409 })

    const idColumn = await service
      .addColumn({
        idempotencyKey: "v0207-add-id",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "dup_notes",
        column: {
          name: "id",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(idColumn).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
  })

  it("renames a plain column and refuses generated, identity, and primary-key columns", async () => {
    await createManagedTable("column_kinds")
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.column_kinds
           ADD COLUMN computed integer GENERATED ALWAYS AS (1) STORED`,
      )
      await client.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.column_kinds
           ADD COLUMN serial_no bigint GENERATED ALWAYS AS IDENTITY`,
      )
    })

    const outcome = await service.renameColumn({
      idempotencyKey: "v0207-rename-column",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "column_kinds",
      column: "title",
      newName: "heading",
    })
    expect(outcome.replayed).toBe(false)
    const catalogued = await readCatalogueTable(APP_SCHEMA, "column_kinds")
    expect(catalogued?.columns.map((entry) => entry.name)).toContain("heading")

    for (const [index, column] of ["computed", "serial_no", "id"].entries()) {
      const error = await service
        .renameColumn({
          idempotencyKey: `v0207-rename-guard-${String(index)}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "column_kinds",
          column,
          newName: `renamed_${String(index)}`,
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        )
      expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    }
  })

  it("drops a plain column with the exact confirmation", async () => {
    await createManagedTable("drop_column")
    await service.addColumn({
      idempotencyKey: "v0207-dropcol-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "drop_column",
      column: {
        name: "body",
        type: "text",
        nullable: true,
        default: { kind: "none" },
      },
    })

    const wrong = await service
      .dropColumn({
        idempotencyKey: "v0207-dropcol-wrong",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "drop_column",
        column: "body",
        confirm: "body",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(wrong).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const outcome = await service.dropColumn({
      idempotencyKey: "v0207-dropcol-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "drop_column",
      column: "body",
      confirm: `${APP_SCHEMA}.drop_column.body`,
    })
    expect(outcome.replayed).toBe(false)
    const catalogued = await readCatalogueTable(APP_SCHEMA, "drop_column")
    expect(catalogued?.columns.map((entry) => entry.name)).not.toContain("body")
    expect((await historyRow("v0207-dropcol-1"))?.status).toBe("succeeded")
  })

  it("refuses to drop columns used by constraints or indexes", async () => {
    await createManagedTable("dependent_columns")
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `CREATE INDEX dependent_columns_title_idx
           ON ${quoteIdentifier(APP_SCHEMA)}.dependent_columns (title)`,
      )
    })

    const indexed = await service
      .dropColumn({
        idempotencyKey: "v0207-dropcol-index",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "dependent_columns",
        column: "title",
        confirm: `${APP_SCHEMA}.dependent_columns.title`,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(indexed).toMatchObject({ code: "CONFLICT", status: 409 })

    const pk = await service
      .dropColumn({
        idempotencyKey: "v0207-dropcol-pk",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "dependent_columns",
        column: "id",
        confirm: `${APP_SCHEMA}.dependent_columns.id`,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(pk).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const catalogued = await readCatalogueTable(APP_SCHEMA, "dependent_columns")
    expect(catalogued?.columns.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["id", "title"]),
    )
  })
})

describe("V02-09 defaults, nullability, and the conversion matrix", () => {
  it("sets and drops a typed literal default", async () => {
    await createManagedTable("defaulted_notes")
    const outcome = await service.setColumnDefault({
      idempotencyKey: "v0207-default-set",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "defaulted_notes",
      column: "title",
      default: { kind: "literal", value: "untitled" },
    })
    expect(outcome.replayed).toBe(false)

    const inserted = await insertRow("defaulted_notes", {})
    expect(inserted["title"]).toBe("untitled")

    await service.dropColumnDefault({
      idempotencyKey: "v0207-default-drop",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "defaulted_notes",
      column: "title",
    })
    const catalogued = await readCatalogueTable(APP_SCHEMA, "defaulted_notes")
    expect(
      catalogued?.columns.find((entry) => entry.name === "title")
        ?.defaultExpression,
    ).toBeNull()
  })

  it("applies template defaults on new columns", async () => {
    await createManagedTable("templated_notes")
    await service.addColumn({
      idempotencyKey: "v0207-default-template",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "templated_notes",
      column: {
        name: "created_at",
        type: "timestamptz",
        nullable: false,
        default: { kind: "current_timestamp" },
      },
    })
    const inserted = await insertRow("templated_notes", { title: "ts" })
    expect(inserted["created_at"]).toBeInstanceOf(Date)
  })

  it("refuses template/type mismatches and unmanageable column types", async () => {
    await createManagedTable("guarded_defaults")
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.guarded_defaults
           ADD COLUMN amount numeric(10,2)`,
      )
      await client.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.guarded_defaults
           ADD COLUMN computed integer GENERATED ALWAYS AS (1) STORED`,
      )
    })

    const mismatch = await service
      .setColumnDefault({
        idempotencyKey: "v0207-default-mismatch",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "guarded_defaults",
        column: "title",
        default: { kind: "random_uuid" },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(mismatch).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const unmanageable = await service
      .setColumnDefault({
        idempotencyKey: "v0207-default-unmanaged",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "guarded_defaults",
        column: "amount",
        default: { kind: "literal", value: 1 },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(unmanageable).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })

    const generated = await service
      .setColumnDefault({
        idempotencyKey: "v0207-default-generated",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "guarded_defaults",
        column: "computed",
        default: { kind: "literal", value: 1 },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(generated).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
  })

  it("sets NOT NULL only when no NULL values exist and drops NOT NULL freely", async () => {
    await createManagedTable("nullable_notes")
    await service.addColumn({
      idempotencyKey: "v0207-null-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "nullable_notes",
      column: {
        name: "body",
        type: "text",
        nullable: true,
        default: { kind: "none" },
      },
    })
    await insertRow("nullable_notes", { title: "a", body: "text" })
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.nullable_notes (title, body) VALUES ('b', NULL)`,
      )
    })

    const hasNulls = await service
      .setColumnNotNull({
        idempotencyKey: "v0207-null-refuse",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "nullable_notes",
        column: "body",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(hasNulls).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    let catalogued = await readCatalogueTable(APP_SCHEMA, "nullable_notes")
    expect(
      catalogued?.columns.find((entry) => entry.name === "body")?.isNullable,
    ).toBe(true)

    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `DELETE FROM ${quoteIdentifier(APP_SCHEMA)}.nullable_notes WHERE body IS NULL`,
      )
    })
    const outcome = await service.setColumnNotNull({
      idempotencyKey: "v0207-null-set",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "nullable_notes",
      column: "body",
    })
    expect(outcome.replayed).toBe(false)
    catalogued = await readCatalogueTable(APP_SCHEMA, "nullable_notes")
    expect(
      catalogued?.columns.find((entry) => entry.name === "body")?.isNullable,
    ).toBe(false)

    await service.dropColumnNotNull({
      idempotencyKey: "v0207-null-drop",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "nullable_notes",
      column: "body",
    })
    catalogued = await readCatalogueTable(APP_SCHEMA, "nullable_notes")
    expect(
      catalogued?.columns.find((entry) => entry.name === "body")?.isNullable,
    ).toBe(true)
  })

  it("converts integer to bigint preserving every value", async () => {
    await createManagedTable("convert_me")
    await service.addColumn({
      idempotencyKey: "v0207-convert-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "convert_me",
      column: {
        name: "priority",
        type: "integer",
        nullable: false,
        default: { kind: "none" },
      },
    })
    await insertRow("convert_me", { title: "a", priority: -2147483648 })
    await insertRow("convert_me", { title: "b", priority: 2147483647 })

    const outcome = await service.changeColumnType({
      idempotencyKey: "v0207-convert-int",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "convert_me",
      column: "priority",
      toType: "bigint",
    })
    expect(outcome.replayed).toBe(false)

    // int8 comes back from the driver as decimal strings.
    expect(await selectValues("convert_me", "priority")).toEqual([
      "-2147483648",
      "2147483647",
    ])
    const catalogued = await readCatalogueTable(APP_SCHEMA, "convert_me")
    expect(
      catalogued?.columns.find((entry) => entry.name === "priority")
        ?.renderedType,
    ).toBe("bigint")
  })

  it("converts date to timestamp preserving the calendar day", async () => {
    await createManagedTable("convert_date")
    await service.addColumn({
      idempotencyKey: "v0207-convert-date-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "convert_date",
      column: {
        name: "due_on",
        type: "date",
        nullable: true,
        default: { kind: "none" },
      },
    })
    await insertRow("convert_date", { title: "leap", due_on: "2024-02-29" })

    await service.changeColumnType({
      idempotencyKey: "v0207-convert-date",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "convert_date",
      column: "due_on",
      toType: "timestamp",
    })

    const values = await withClient(adminRoleUrl(), async (client) => {
      const result = await client.query<{ value: string }>(
        `SELECT due_on::text AS value FROM ${quoteIdentifier(APP_SCHEMA)}.convert_date`,
      )
      return result.rows.map((row) => row.value)
    })
    expect(values).toEqual(["2024-02-29 00:00:00"])
  })

  it("refuses conversions outside the matrix and conversions with defaults or dependencies", async () => {
    await createManagedTable("convert_guards")
    await service.addColumn({
      idempotencyKey: "v0207-convert-guards-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "convert_guards",
      column: {
        name: "priority",
        type: "integer",
        nullable: false,
        default: { kind: "literal", value: 0 },
      },
    })
    await service.addColumn({
      idempotencyKey: "v0207-convert-plain-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "convert_guards",
      column: {
        name: "plain",
        type: "integer",
        nullable: true,
        default: { kind: "none" },
      },
    })

    const outsideMatrix = await service
      .changeColumnType({
        idempotencyKey: "v0207-convert-outside",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "convert_guards",
        column: "title",
        toType: "uuid",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(outsideMatrix).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })

    const uuidTarget = await service
      .changeColumnType({
        idempotencyKey: "v0207-convert-uuid",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "convert_guards",
        column: "plain",
        toType: "uuid",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(uuidTarget).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const withDefault = await service
      .changeColumnType({
        idempotencyKey: "v0207-convert-defaulted",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "convert_guards",
        column: "priority",
        toType: "bigint",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(withDefault).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const pk = await service
      .changeColumnType({
        idempotencyKey: "v0207-convert-pk",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "convert_guards",
        column: "id",
        toType: "uuid",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(pk).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const catalogued = await readCatalogueTable(APP_SCHEMA, "convert_guards")
    expect(
      catalogued?.columns.find((entry) => entry.name === "priority")
        ?.renderedType,
    ).toBe("integer")
  })

  it("refuses column mutations on exposed tables", async () => {
    await createManagedTable("exposed_columns")
    expose(APP_SCHEMA, "exposed_columns")
    try {
      const add = await service
        .addColumn({
          idempotencyKey: "v0207-exposed-add",
          actor: "operator",
          schema: APP_SCHEMA,
          table: "exposed_columns",
          column: {
            name: "body",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        )
      expect(add).toMatchObject({ code: "CONFLICT", status: 409 })

      const drop = await service
        .dropColumn({
          idempotencyKey: "v0207-exposed-drop",
          actor: "operator",
          schema: APP_SCHEMA,
          table: "exposed_columns",
          column: "title",
          confirm: `${APP_SCHEMA}.exposed_columns.title`,
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        )
      expect(drop).toMatchObject({ code: "CONFLICT", status: 409 })

      const catalogued = await readCatalogueTable(APP_SCHEMA, "exposed_columns")
      expect(catalogued?.columns.map((entry) => entry.name)).toEqual([
        "id",
        "title",
      ])
    } finally {
      unexposeAll()
    }
  })
})

describe("R3 review findings (JDW-21)", () => {
  it("replays a changeColumnType key from the recorded command after the catalogue shows the destination type", async () => {
    await createManagedTable("r3_type_replay")
    await service.addColumn({
      idempotencyKey: "v0207-r3-type-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_type_replay",
      column: {
        name: "priority",
        type: "integer",
        nullable: false,
        default: { kind: "none" },
      },
    })
    await insertRow("r3_type_replay", { title: "a", priority: 7 })

    const converted = await service.changeColumnType({
      idempotencyKey: "v0207-r3-type-convert",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_type_replay",
      column: "priority",
      toType: "bigint",
    })
    expect(converted.replayed).toBe(false)

    // The catalogue now shows bigint; the retry must still compile the
    // recorded integer -> bigint statement and be classified as a replay.
    const replay = await service.changeColumnType({
      idempotencyKey: "v0207-r3-type-convert",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_type_replay",
      column: "priority",
      toType: "bigint",
    })
    expect(replay.replayed).toBe(true)
    expect(replay.record?.status).toBe("succeeded")
    expect(await selectValues("r3_type_replay", "priority")).toEqual(["7"])
    const catalogued = await readCatalogueTable(APP_SCHEMA, "r3_type_replay")
    expect(
      catalogued?.columns.find((entry) => entry.name === "priority")
        ?.renderedType,
    ).toBe("bigint")

    // A different toType on the used key still reaches the executor and
    // conflicts on the checksum.
    const conflict = await service
      .changeColumnType({
        idempotencyKey: "v0207-r3-type-convert",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "r3_type_replay",
        column: "priority",
        toType: "numeric",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(conflict).toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("replays a setColumnDefault key without re-reading the live column type", async () => {
    await createManagedTable("r3_default_replay")
    await service.addColumn({
      idempotencyKey: "v0207-r3-default-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_default_replay",
      column: {
        name: "due_on",
        type: "date",
        nullable: true,
        default: { kind: "none" },
      },
    })

    const set = await service.setColumnDefault({
      idempotencyKey: "v0207-r3-default-set",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_default_replay",
      column: "due_on",
      default: { kind: "literal", value: "2026-01-01" },
    })
    expect(set.replayed).toBe(false)

    // A later conversion moves the live type to timestamp (the default is
    // dropped first, as the conversion guard requires); the recorded key
    // must still replay instead of rejecting the original date literal.
    await service.dropColumnDefault({
      idempotencyKey: "v0207-r3-default-clear",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_default_replay",
      column: "due_on",
    })
    await service.changeColumnType({
      idempotencyKey: "v0207-r3-default-convert",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_default_replay",
      column: "due_on",
      toType: "timestamp",
    })

    const replay = await service.setColumnDefault({
      idempotencyKey: "v0207-r3-default-set",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_default_replay",
      column: "due_on",
      default: { kind: "literal", value: "2026-01-01" },
    })
    expect(replay.replayed).toBe(true)
    expect(replay.record?.status).toBe("succeeded")
    expect((await historyRow("v0207-r3-default-set"))?.status).toBe("succeeded")
  })

  it("refuses dry-run drops on reused keys for exposed tables with a wrong confirmation", async () => {
    await createManagedTable("r3_dry_guard")
    expose(APP_SCHEMA, "r3_dry_guard")
    try {
      // Give the key a recorded operation so the replay-first probe finds a
      // row; a dry run must still run the confirmation/exposure guards.
      await createManagedTable("r3_dry_source")
      await service.dropTable({
        idempotencyKey: "v0207-r3-dry-key",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "r3_dry_source",
        confirm: `${APP_SCHEMA}.r3_dry_source`,
      })

      const error = await service
        .dropTable({
          idempotencyKey: "v0207-r3-dry-key",
          actor: "operator",
          schema: APP_SCHEMA,
          table: "r3_dry_guard",
          confirm: "nope",
          dryRun: true,
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        )
      expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
      expect(await tableExists(APP_SCHEMA, "r3_dry_guard")).toBe(true)
      expect(await historyRow("v0207-r3-dry-key")).toMatchObject({
        status: "succeeded",
      })
    } finally {
      unexposeAll()
    }
  })

  it("refuses identity and generated columns for both default commands", async () => {
    await createManagedTable("r3_identity_columns")
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.r3_identity_columns
           ADD COLUMN serial_no bigint GENERATED ALWAYS AS IDENTITY`,
      )
      await client.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.r3_identity_columns
           ADD COLUMN computed integer GENERATED ALWAYS AS (1) STORED`,
      )
    })

    const setIdentity = await service
      .setColumnDefault({
        idempotencyKey: "v0207-r3-identity-set",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "r3_identity_columns",
        column: "serial_no",
        default: { kind: "literal", value: 1 },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(setIdentity).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const dropIdentity = await service
      .dropColumnDefault({
        idempotencyKey: "v0207-r3-identity-drop",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "r3_identity_columns",
        column: "serial_no",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(dropIdentity).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })

    const dropGenerated = await service
      .dropColumnDefault({
        idempotencyKey: "v0207-r3-generated-drop",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "r3_identity_columns",
        column: "computed",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(dropGenerated).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })

    expect(await historyRow("v0207-r3-identity-set")).toBeNull()
    expect(await historyRow("v0207-r3-identity-drop")).toBeNull()
    expect(await historyRow("v0207-r3-generated-drop")).toBeNull()
  })

  it("fails closed when the locked catalogue type drifted from the compiled fromType", async () => {
    await createManagedTable("r3_stale_convert")
    await service.addColumn({
      idempotencyKey: "v0207-r3-stale-add",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "r3_stale_convert",
      column: {
        name: "amount",
        type: "numeric",
        nullable: false,
        default: { kind: "none" },
      },
    })
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.r3_stale_convert (title, amount) VALUES ('half', 1.5)`,
      )
    })

    // The catalogue now claims the column is integer (a concurrent change the
    // compiler cannot see); integer -> bigint passes the frozen matrix, but
    // the locked re-check inside the DDL transaction must fail closed instead
    // of letting PostgreSQL round 1.5 to 2.
    const lyingCatalogue: SchemaCatalogueReader = {
      read: async () => {
        const snapshot = await catalogue.read()
        return {
          schemas: snapshot.schemas.map((schemaObject) => ({
            ...schemaObject,
            tables: schemaObject.tables.map((tableObject) => ({
              ...tableObject,
              columns: tableObject.columns.map((columnObject) =>
                schemaObject.name === APP_SCHEMA &&
                tableObject.name === "r3_stale_convert" &&
                columnObject.name === "amount"
                  ? {
                      ...columnObject,
                      renderedType: "integer",
                      type: {
                        schema: "pg_catalog",
                        name: "int4",
                        kind: "base" as const,
                      },
                      baseType: null,
                    }
                  : columnObject,
              ),
            })),
          })),
        }
      },
    }
    const lyingService = createSchemaMutationService({
      pool: adminPool,
      catalogue: lyingCatalogue,
      registry,
      adminRole: ADMIN_ROLE,
      executor: createSchemaDdlExecutor({
        pool: adminPool,
        createOperationLog: (query) => createSchemaOperationLog({ query }),
      }),
    })

    const error = await lyingService
      .changeColumnType({
        idempotencyKey: "v0207-r3-stale-convert",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "r3_stale_convert",
        column: "amount",
        toType: "bigint",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      )
    expect(error).toMatchObject({ code: "CONFLICT", status: 409 })

    const values = await withClient(adminRoleUrl(), async (client) => {
      const result = await client.query<{ amount: unknown }>(
        `SELECT amount FROM ${quoteIdentifier(APP_SCHEMA)}.r3_stale_convert`,
      )
      return result.rows.map((row) => row.amount)
    })
    expect(values).toEqual(["1.5"])
    const catalogued = await readCatalogueTable(APP_SCHEMA, "r3_stale_convert")
    expect(
      catalogued?.columns.find((entry) => entry.name === "amount")
        ?.renderedType,
    ).toBe("numeric")
    expect(await historyRow("v0207-r3-stale-convert")).toBeNull()
  })
})
