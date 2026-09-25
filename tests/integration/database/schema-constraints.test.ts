// Integration tests for the V02-11..V02-12 index, unique-constraint, and
// foreign-key commands against real PostgreSQL: lifecycle, deterministic
// and explicit names, allowlist refusals, ownership/internal guards,
// dependency behaviour, idempotency replay, and dry-run rollback.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type {
  SchemaCatalogueReader,
  SchemaCatalogueTable,
} from "../../../src/contracts/index.js"
import {
  createSchemaCatalogueReader,
  createSchemaConstraintService,
  createSchemaDdlExecutor,
  createSchemaMutationService,
  createSchemaOperationLog,
  createPool,
  type ManagedColumnSpec,
  type Pool,
  type SchemaConstraintService,
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

const ADMIN_ROLE = "mjb_v0211_admin"
const ADMIN_ROLE_PASSWORD = "v0211_admin_password"
const APP_SCHEMA = "mjb_v0211_app"

function adminRoleUrl(): string {
  const url = new URL(adminDatabaseUrl as string)
  url.username = ADMIN_ROLE
  url.password = ADMIN_ROLE_PASSWORD
  return url.toString()
}

let adminPool: Pool
let catalogue: SchemaCatalogueReader
let mutations: SchemaMutationService
let constraints: SchemaConstraintService

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
    idempotencyKey: `v0211-setup-${table}`,
    actor: "setup",
    schema: APP_SCHEMA,
    table,
    columns: [TEXT_COLUMN, ...extraColumns],
  })
  expect(outcome.replayed).toBe(false)
}

async function readCatalogueTable(
  schema: string,
  table: string,
): Promise<SchemaCatalogueTable | null> {
  const snapshot = await catalogue.read()
  const schemaObject = snapshot.schemas.find((entry) => entry.name === schema)
  return schemaObject?.tables.find((entry) => entry.name === table) ?? null
}

async function indexNames(schema: string, table: string): Promise<string[]> {
  const catalogued = await readCatalogueTable(schema, table)
  return (catalogued?.indexes ?? []).map((index) => index.name)
}

async function constraintNames(
  schema: string,
  table: string,
): Promise<string[]> {
  const catalogued = await readCatalogueTable(schema, table)
  return (catalogued?.constraints ?? []).map((constraint) => constraint.name)
}

async function historyStatus(key: string): Promise<string | null> {
  return withClient(adminDatabaseUrl as string, async (admin) => {
    const result = await admin.query(
      `SELECT status FROM microjbase.schema_operations WHERE idempotency_key = $1`,
      [key],
    )
    return (result.rows[0] as { status: string } | undefined)?.status ?? null
  })
}

async function dropAdminRole(admin: import("pg").Client): Promise<void> {
  // Revoke the microjbase grants before dropping: ACL dependencies otherwise
  // block DROP ROLE. The block is conditional so a fresh database (role not
  // yet created) is fine.
  await admin.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ADMIN_ROLE}') THEN
        EXECUTE 'REVOKE ALL ON microjbase.schema_operations FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE ALL ON SEQUENCE microjbase.schema_operations_id_seq FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE USAGE ON SCHEMA microjbase FROM "${ADMIN_ROLE}"';
        EXECUTE 'DROP ROLE "${ADMIN_ROLE}"';
      END IF;
    END
    $$;
  `)
}

beforeAll(async () => {
  await applyMigrationsAndGrants(
    adminDatabaseUrl as string,
    new URL(databaseUrl as string).username,
  )

  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'v0211-%'`,
    )
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await dropAdminRole(admin)
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(ADMIN_ROLE)} WITH LOGIN PASSWORD '${ADMIN_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
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
  })

  adminPool = createPool({ databaseUrl: adminRoleUrl(), maxConnections: 5 })
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
  constraints = createSchemaConstraintService({
    pool: adminPool,
    catalogue,
    adminRole: ADMIN_ROLE,
    executor,
  })

  await createManagedTable("users_table", [
    {
      name: "email",
      type: "text" as const,
      nullable: false,
      default: { kind: "none" as const },
    },
  ])
  await createManagedTable("orders", [
    {
      name: "user_ref",
      type: "uuid" as const,
      nullable: true,
      default: { kind: "none" as const },
    },
    {
      name: "quantity",
      type: "integer" as const,
      nullable: false,
      default: { kind: "literal" as const, value: 1 },
    },
  ])
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

describe("index lifecycle (V02-11)", () => {
  it("creates an index with a deterministic name and drops it", async () => {
    const createOutcome = await constraints.createIndex({
      idempotencyKey: "v0211-idx-create-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["quantity"],
    })
    expect(createOutcome.replayed).toBe(false)
    expect(await indexNames(APP_SCHEMA, "orders")).toContain(
      "mjb_orders_quantity_idx",
    )

    const dropOutcome = await constraints.dropIndex({
      idempotencyKey: "v0211-idx-drop-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      name: "mjb_orders_quantity_idx",
    })
    expect(dropOutcome.replayed).toBe(false)
    expect(await indexNames(APP_SCHEMA, "orders")).not.toContain(
      "mjb_orders_quantity_idx",
    )
  })

  it("honours explicit names and validates them", async () => {
    await constraints.createIndex({
      idempotencyKey: "v0211-idx-explicit-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["user_ref"],
      name: "orders_user_ref_idx",
    })
    expect(await indexNames(APP_SCHEMA, "orders")).toContain(
      "orders_user_ref_idx",
    )

    await expect(
      constraints.createIndex({
        idempotencyKey: "v0211-idx-hostile-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        columns: ["user_ref"],
        name: 'evil";drop',
      }),
    ).rejects.toThrow(/Invalid SQL identifier/)
    await expect(historyStatus("v0211-idx-hostile-1")).resolves.toBeNull()
  })

  it("refuses duplicate index names", async () => {
    await expect(
      constraints.createIndex({
        idempotencyKey: "v0211-idx-dup-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        columns: ["user_ref"],
        name: "orders_user_ref_idx",
      }),
    ).rejects.toThrow(/already exists/)
  })

  it("refuses unknown columns, missing tables, and internal schemas", async () => {
    await expect(
      constraints.createIndex({
        idempotencyKey: "v0211-idx-badcol-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        columns: ["missing"],
      }),
    ).rejects.toThrow(/does not exist/)
    await expect(
      constraints.createIndex({
        idempotencyKey: "v0211-idx-missing-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "missing",
        columns: ["id"],
      }),
    ).rejects.toThrow(/does not exist/)
    await expect(
      constraints.createIndex({
        idempotencyKey: "v0211-idx-internal-1",
        actor: "test",
        schema: "microjbase",
        table: "users",
        columns: ["id"],
      }),
    ).rejects.toThrow(/Internal schemas/)
  })

  it("refuses to drop a constraint-backed index by name", async () => {
    await constraints.addUniqueConstraint({
      idempotencyKey: "v0211-uniq-for-index-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "users_table",
      columns: ["email"],
      name: "users_table_email_uniq",
    })
    await expect(
      constraints.dropIndex({
        idempotencyKey: "v0211-idx-backed-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "users_table",
        name: "users_table_email_uniq",
      }),
    ).rejects.toThrow(/backed by a constraint/)
  })

  it("refuses to drop an index that belongs to another table", async () => {
    await constraints.createIndex({
      idempotencyKey: "v0211-idx-other-table-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "users_table",
      columns: ["email"],
      name: "users_email_idx",
    })
    await expect(
      constraints.dropIndex({
        idempotencyKey: "v0211-idx-wrong-table-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        name: "users_email_idx",
      }),
    ).rejects.toThrow(/belongs to/)
    await constraints.dropIndex({
      idempotencyKey: "v0211-idx-other-table-drop-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "users_table",
      name: "users_email_idx",
    })
  })

  it("replays an idempotent create without re-executing", async () => {
    const first = await constraints.createIndex({
      idempotencyKey: "v0211-idx-replay-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["quantity"],
      name: "orders_quantity_replay_idx",
    })
    expect(first.replayed).toBe(false)
    const second = await constraints.createIndex({
      idempotencyKey: "v0211-idx-replay-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["quantity"],
      name: "orders_quantity_replay_idx",
    })
    expect(second.replayed).toBe(true)
    expect(second.record?.status).toBe("succeeded")
    expect(await indexNames(APP_SCHEMA, "orders")).toContain(
      "orders_quantity_replay_idx",
    )
  })

  it("dry-run compiles and rolls back without creating the index", async () => {
    const outcome = await constraints.createIndex({
      idempotencyKey: "v0211-idx-dry-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["quantity"],
      name: "orders_quantity_dry_idx",
      dryRun: true,
    })
    expect(outcome.dryRun).toBe(true)
    expect(await indexNames(APP_SCHEMA, "orders")).not.toContain(
      "orders_quantity_dry_idx",
    )
    await expect(historyStatus("v0211-idx-dry-1")).resolves.toBeNull()
  })
})

describe("unique constraints (V02-11)", () => {
  it("creates and drops a unique constraint", async () => {
    const outcome = await constraints.addUniqueConstraint({
      idempotencyKey: "v0211-uniq-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["user_ref", "quantity"],
    })
    expect(outcome.replayed).toBe(false)
    expect(await constraintNames(APP_SCHEMA, "orders")).toContain(
      "mjb_orders_user_ref_quantity_uniq",
    )

    await constraints.dropConstraint({
      idempotencyKey: "v0211-uniq-drop-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      name: "mjb_orders_user_ref_quantity_uniq",
    })
    expect(await constraintNames(APP_SCHEMA, "orders")).not.toContain(
      "mjb_orders_user_ref_quantity_uniq",
    )
  })

  it("enforces uniqueness at the database level", async () => {
    await constraints.addUniqueConstraint({
      idempotencyKey: "v0211-uniq-enforce-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "users_table",
      columns: ["email"],
      name: "users_table_email_enforce_uniq",
    })
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("users_table")} (title, email)
         VALUES ('a', 'same@example.com')`,
      )
      await expect(
        client.query(
          `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("users_table")} (title, email)
           VALUES ('b', 'same@example.com')`,
        ),
      ).rejects.toThrow(/duplicate key/)
    })
  })
})

describe("foreign keys (V02-12)", () => {
  it("creates and drops a foreign key with frozen actions", async () => {
    const outcome = await constraints.addForeignKey({
      idempotencyKey: "v0211-fk-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["user_ref"],
      references: { schema: APP_SCHEMA, table: "users_table", columns: ["id"] },
      onUpdate: "no_action",
      onDelete: "cascade",
    })
    expect(outcome.replayed).toBe(false)

    const catalogued = await readCatalogueTable(APP_SCHEMA, "orders")
    const fk = catalogued?.constraints.find(
      (constraint) => constraint.name === "mjb_orders_user_ref_fkey",
    )
    expect(fk?.classification).toBe("foreign_key")
    expect(fk?.references).toEqual({
      schema: APP_SCHEMA,
      table: "users_table",
      columns: ["id"],
    })
    expect(fk?.onUpdate).toBe("no_action")
    expect(fk?.onDelete).toBe("cascade")

    await constraints.dropConstraint({
      idempotencyKey: "v0211-fk-drop-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      name: "mjb_orders_user_ref_fkey",
    })
    expect(await constraintNames(APP_SCHEMA, "orders")).not.toContain(
      "mjb_orders_user_ref_fkey",
    )
  })

  it("enforces the FK at the database level", async () => {
    await constraints.addForeignKey({
      idempotencyKey: "v0211-fk-enforce-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["user_ref"],
      references: { schema: APP_SCHEMA, table: "users_table", columns: ["id"] },
      onUpdate: "restrict",
      onDelete: "set_null",
    })
    let userId = ""
    await withClient(adminRoleUrl(), async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("users_table")} (title, email)
         VALUES ('fk owner', 'fk@example.com') RETURNING id`,
      )
      userId = inserted.rows[0]?.id ?? ""
      await expect(
        client.query(
          `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("orders")} (title, user_ref)
           VALUES ('bad ref', '99999999-9999-9999-9999-999999999999')`,
        ),
      ).rejects.toThrow(/foreign key/)

      // SET NULL nulls the referencing column when the target row deletes.
      await client.query(
        `INSERT INTO ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("orders")} (title, user_ref)
         VALUES ('good ref', $1)`,
        [userId],
      )
      await client.query(
        `DELETE FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("users_table")} WHERE id = $1`,
        [userId],
      )
      const remaining = await client.query<{ user_ref: string | null }>(
        `SELECT user_ref FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("orders")} WHERE title = 'good ref'`,
      )
      expect(remaining.rows[0]?.user_ref).toBeNull()
    })
    await constraints.dropConstraint({
      idempotencyKey: "v0211-fk-enforce-drop-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      name: "mjb_orders_user_ref_fkey",
    })
  })

  it("refuses SET NULL on non-nullable referencing columns", async () => {
    await expect(
      constraints.addForeignKey({
        idempotencyKey: "v0211-fk-setnull-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        columns: ["quantity"],
        references: {
          schema: APP_SCHEMA,
          table: "users_table",
          columns: ["id"],
        },
        onUpdate: "set_null",
        onDelete: "no_action",
      }),
    ).rejects.toThrow(/nullable/)
  })

  it("refuses SET DEFAULT actions outside the frozen allowlist", async () => {
    await expect(
      constraints.addForeignKey({
        idempotencyKey: "v0211-fk-setdefault-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        columns: ["user_ref"],
        references: {
          schema: APP_SCHEMA,
          table: "users_table",
          columns: ["id"],
        },
        onUpdate: "no_action",
        onDelete: "set_default" as never,
      }),
    ).rejects.toThrow(/not allowlisted/)
  })

  it("refuses unverified targets and mismatched types", async () => {
    await expect(
      constraints.addForeignKey({
        idempotencyKey: "v0211-fk-missing-target-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        columns: ["user_ref"],
        references: { schema: APP_SCHEMA, table: "missing", columns: ["id"] },
        onUpdate: "no_action",
        onDelete: "no_action",
      }),
    ).rejects.toThrow(/does not exist/)
    await expect(
      constraints.addForeignKey({
        idempotencyKey: "v0211-fk-type-mismatch-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        columns: ["title"],
        references: {
          schema: APP_SCHEMA,
          table: "users_table",
          columns: ["id"],
        },
        onUpdate: "no_action",
        onDelete: "no_action",
      }),
    ).rejects.toThrow(/types must match/)
  })

  it("refuses self-managed primary keys and read-only constraint classes", async () => {
    await expect(
      constraints.dropConstraint({
        idempotencyKey: "v0211-pk-drop-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        name: "orders_pkey",
      }),
    ).rejects.toThrow(/Primary keys are managed by the table lifecycle/)

    // Check constraints are read-only metadata: create one out of band and
    // refuse to drop it.
    await withClient(adminRoleUrl(), async (client) => {
      await client.query(
        `ALTER TABLE ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("orders")}
         ADD CONSTRAINT orders_quantity_check CHECK (quantity > 0)`,
      )
    })
    await expect(
      constraints.dropConstraint({
        idempotencyKey: "v0211-check-drop-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        name: "orders_quantity_check",
      }),
    ).rejects.toThrow(/read-only metadata/)
  })

  it("refuses a foreign table not owned by the schema-admin role", async () => {
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `CREATE TABLE ${quoteIdentifier(APP_SCHEMA)}.foreign_owned (id UUID PRIMARY KEY)`,
      )
    })
    await expect(
      constraints.addForeignKey({
        idempotencyKey: "v0211-fk-foreign-1",
        actor: "test",
        schema: APP_SCHEMA,
        table: "orders",
        columns: ["user_ref"],
        references: {
          schema: APP_SCHEMA,
          table: "foreign_owned",
          columns: ["id"],
        },
        onUpdate: "no_action",
        onDelete: "no_action",
      }),
    ).rejects.toThrow(/not owned by the schema-admin role/)
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `DROP TABLE ${quoteIdentifier(APP_SCHEMA)}.foreign_owned`,
      )
    })
  })

  it("replays an idempotent foreign key without re-executing", async () => {
    const first = await constraints.addForeignKey({
      idempotencyKey: "v0211-fk-replay-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["user_ref"],
      references: { schema: APP_SCHEMA, table: "users_table", columns: ["id"] },
      onUpdate: "no_action",
      onDelete: "cascade",
    })
    expect(first.replayed).toBe(false)
    const second = await constraints.addForeignKey({
      idempotencyKey: "v0211-fk-replay-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      columns: ["user_ref"],
      references: { schema: APP_SCHEMA, table: "users_table", columns: ["id"] },
      onUpdate: "no_action",
      onDelete: "cascade",
    })
    expect(second.replayed).toBe(true)
    await constraints.dropConstraint({
      idempotencyKey: "v0211-fk-replay-drop-1",
      actor: "test",
      schema: APP_SCHEMA,
      table: "orders",
      name: "mjb_orders_user_ref_fkey",
    })
  })
})
