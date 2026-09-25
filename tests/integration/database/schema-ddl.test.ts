// Integration tests for the V02-06 typed DDL compiler and executor against
// real PostgreSQL: dry-run, execution, replay, conflict, error mapping,
// advisory-lock serialization, rollback, lane isolation, and log redaction.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  SCHEMA_DDL_LOCK_KEY,
  compileCreateTable,
  createPool,
  createSchemaDdlExecutor,
  createSchemaOperationLog,
  type Pool,
  type SchemaDdlExecutor,
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

const ADMIN_ROLE = "mjb_v0206_admin"
const ADMIN_ROLE_PASSWORD = "v0206_admin_password"
const APP_SCHEMA = "mjb_v0206_app"

function adminRoleUrl(): string {
  const url = new URL(adminDatabaseUrl as string)
  url.username = ADMIN_ROLE
  url.password = ADMIN_ROLE_PASSWORD
  return url.toString()
}

let adminPool: Pool
let executor: SchemaDdlExecutor
let logSink: string[]

function notesSpec(table: string): Parameters<typeof compileCreateTable>[0] {
  return {
    schema: APP_SCHEMA,
    table,
    columns: [
      {
        name: "id",
        type: "uuid",
        nullable: false,
        default: { kind: "random_uuid" },
      },
      {
        name: "title",
        type: "text",
        nullable: false,
        default: { kind: "none" },
      },
      {
        name: "body",
        type: "text",
        nullable: true,
        default: { kind: "literal", value: "operator's default" },
      },
      {
        name: "priority",
        type: "integer",
        nullable: false,
        default: { kind: "literal", value: 0 },
      },
      {
        name: "created_at",
        type: "timestamptz",
        nullable: false,
        default: { kind: "current_timestamp" },
      },
      {
        name: "payload",
        type: "jsonb",
        nullable: true,
        default: { kind: "literal", value: null },
      },
    ],
  }
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

beforeAll(async () => {
  await applyMigrationsAndGrants(
    adminDatabaseUrl as string,
    new URL(databaseUrl as string).username,
  )

  await withClient(adminDatabaseUrl as string, async (admin) => {
    // The suite owns the v0206- key namespace; clear leftovers from previous
    // runs so durable history never poisons fixed test keys.
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'v0206-%'`,
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
  })

  adminPool = createPool({ databaseUrl: adminRoleUrl(), maxConnections: 5 })
  const operationLog = createSchemaOperationLog({
    query: (text, values) => adminPool.query(text, values),
  })
  logSink = []
  executor = createSchemaDdlExecutor({
    pool: adminPool,
    operationLog,
    logger: {
      error: () => undefined,
      warn: (line: string) => logSink.push(line),
      info: (line: string) => logSink.push(line),
      debug: () => undefined,
    },
  })
})

afterAll(async () => {
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
      `REVOKE USAGE ON SCHEMA microjbase FROM ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(ADMIN_ROLE)}`)
  })
})

describe("schema DDL executor against real PostgreSQL", () => {
  it("dry-run compiles and rolls back without leaving a table or history", async () => {
    const plan = compileCreateTable(notesSpec("dry_run_notes"))
    const outcome = await executor.execute(plan, {
      idempotencyKey: "v0206-dry-1",
      commandType: "schema.table.create",
      command: { schema: APP_SCHEMA, table: "dry_run_notes" },
      actor: "operator",
      dryRun: true,
    })
    expect(outcome.dryRun).toBe(true)
    expect(await tableExists(APP_SCHEMA, "dry_run_notes")).toBe(false)
    expect(await historyRow("v0206-dry-1")).toBeNull()
  })

  it("creates a table with allowlisted types and template defaults, owned by the schema-admin role", async () => {
    const outcome = await executor.execute(
      compileCreateTable(notesSpec("real_notes")),
      {
        idempotencyKey: "v0206-create-1",
        commandType: "schema.table.create",
        command: { schema: APP_SCHEMA, table: "real_notes" },
        actor: "operator",
      },
    )
    expect(outcome.replayed).toBe(false)
    expect(outcome.record?.status).toBe("succeeded")

    await withClient(adminDatabaseUrl as string, async (admin) => {
      const table = await admin.query<{
        owner: string
        has_rls: boolean
      }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS has_rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = 'real_notes'`,
        [APP_SCHEMA],
      )
      expect(table.rows[0]?.owner).toBe(ADMIN_ROLE)

      const columns = await admin.query<{
        column_name: string
        data_type: string
        column_default: string | null
        is_nullable: string
      }>(
        `SELECT column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'real_notes'
         ORDER BY ordinal_position`,
        [APP_SCHEMA],
      )
      const byName = new Map(columns.rows.map((row) => [row.column_name, row]))
      expect(byName.get("id")?.data_type).toBe("uuid")
      expect(byName.get("id")?.column_default).toContain("gen_random_uuid()")
      expect(byName.get("title")?.is_nullable).toBe("NO")
      expect(byName.get("body")?.column_default).toBe(
        "'operator''s default'::text",
      )
      expect(byName.get("priority")?.column_default).toBe("0")
      expect(byName.get("created_at")?.column_default).toContain(
        "CURRENT_TIMESTAMP",
      )
      expect(byName.get("payload")?.data_type).toBe("jsonb")
    })

    const history = await historyRow("v0206-create-1")
    expect(history?.status).toBe("succeeded")
    expect(history?.result).toEqual({ statementCount: 1 })
  })

  it("replays a succeeded operation without re-executing", async () => {
    const command = { schema: APP_SCHEMA, table: "real_notes" }
    const replayed = await executor.execute(
      compileCreateTable(notesSpec("real_notes")),
      {
        idempotencyKey: "v0206-create-1",
        commandType: "schema.table.create",
        command,
        actor: "operator",
      },
    )
    expect(replayed.replayed).toBe(true)

    await withClient(adminDatabaseUrl as string, async (admin) => {
      const count = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM microjbase.schema_operations WHERE idempotency_key = 'v0206-create-1'`,
      )
      expect(count.rows[0]?.count).toBe(1)
    })
  })

  it("conflicts when the key is reused with a different command", async () => {
    await expect(
      executor.execute(compileCreateTable(notesSpec("real_notes")), {
        idempotencyKey: "v0206-create-1",
        commandType: "schema.table.create",
        command: { schema: APP_SCHEMA, table: "different" },
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("maps duplicate_table to a safe CONFLICT and records the failure", async () => {
    logSink.length = 0
    await expect(
      executor.execute(compileCreateTable(notesSpec("real_notes")), {
        idempotencyKey: "v0206-dup-1",
        commandType: "schema.table.create",
        command: { schema: APP_SCHEMA, table: "real_notes" },
        actor: "operator",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "Relation already exists",
    })

    const history = await historyRow("v0206-dup-1")
    expect(history?.status).toBe("failed")
    expect(history?.error_code).toBe("CONFLICT")
  })

  it("maps a missing schema to TABLE_NOT_FOUND without leaking internals", async () => {
    let thrown: unknown
    try {
      await executor.execute(
        compileCreateTable({
          schema: "mjb_v0206_missing",
          table: "ghost",
          columns: [
            {
              name: "id",
              type: "uuid",
              nullable: false,
              default: { kind: "random_uuid" },
            },
          ],
        }),
        {
          idempotencyKey: "v0206-missing-schema-1",
          commandType: "schema.table.create",
          command: { schema: "mjb_v0206_missing", table: "ghost" },
          actor: "operator",
        },
      )
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: "TABLE_NOT_FOUND", status: 404 })
    const envelope = JSON.stringify((thrown as { toJSON(): unknown }).toJSON())
    expect(envelope).not.toContain("mjb_v0206_missing")
    expect(envelope).not.toContain("3F000")
  })

  it("serializes concurrent DDL on the reserved advisory key", async () => {
    // A session-level advisory lock on the reserved key blocks the executor;
    // the xact lock acquisition waits until the holder releases. The lock
    // must be released from the same session that acquired it.
    const pg = await import("pg")
    const blocker = new pg.default.Client({
      connectionString: adminDatabaseUrl as string,
    })
    await blocker.connect()
    try {
      await blocker.query("SELECT pg_advisory_lock($1)", [
        BigInt.asIntN(64, SCHEMA_DDL_LOCK_KEY),
      ])

      let settled = false
      const pending = executor
        .execute(compileCreateTable(notesSpec("locked_notes")), {
          idempotencyKey: "v0206-lock-1",
          commandType: "schema.table.create",
          command: { schema: APP_SCHEMA, table: "locked_notes" },
          actor: "operator",
        })
        .then((outcome) => {
          settled = true
          return outcome
        })

      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(settled).toBe(false)

      await blocker.query("SELECT pg_advisory_unlock($1)", [
        BigInt.asIntN(64, SCHEMA_DDL_LOCK_KEY),
      ])
      const outcome = await pending
      expect(outcome.record?.status).toBe("succeeded")
    } finally {
      await blocker.end()
    }
  }, 20_000)

  it("racing creators on one table produce exactly one winner", async () => {
    const results = await Promise.allSettled([
      executor.execute(compileCreateTable(notesSpec("race_notes")), {
        idempotencyKey: "v0206-race-a",
        commandType: "schema.table.create",
        command: { schema: APP_SCHEMA, table: "race_notes" },
        actor: "operator",
      }),
      executor.execute(compileCreateTable(notesSpec("race_notes")), {
        idempotencyKey: "v0206-race-b",
        commandType: "schema.table.create",
        command: { schema: APP_SCHEMA, table: "race_notes" },
        actor: "operator",
      }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toMatchObject({
        code: "CONFLICT",
        status: 409,
      })
    }

    const keys = ["v0206-race-a", "v0206-race-b"] as const
    const statuses = await Promise.all(keys.map((key) => historyRow(key)))
    const kinds = statuses.map((row) => row?.status).sort()
    expect(kinds).toEqual(["failed", "succeeded"])
  })

  it("rolls back every statement when a later statement in the transaction fails", async () => {
    const spec = notesSpec("rollback_notes")
    await expect(
      executor.execute([compileCreateTable(spec), compileCreateTable(spec)], {
        idempotencyKey: "v0206-rollback-1",
        commandType: "schema.table.create",
        command: { schema: APP_SCHEMA, table: "rollback_notes" },
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await tableExists(APP_SCHEMA, "rollback_notes")).toBe(false)
    const history = await historyRow("v0206-rollback-1")
    expect(history?.status).toBe("failed")
  })

  it("the restricted runtime lane cannot execute DDL and gets a safe envelope", async () => {
    const runtimePool = createPool({
      databaseUrl: databaseUrl as string,
      maxConnections: 2,
    })
    try {
      const runtimeExecutor = createSchemaDdlExecutor({
        pool: runtimePool,
        operationLog: createSchemaOperationLog({
          query: (text, values) => runtimePool.query(text, values),
        }),
      })
      await expect(
        runtimeExecutor.execute(
          compileCreateTable({
            schema: APP_SCHEMA,
            table: "runtime_escape",
            columns: [
              {
                name: "id",
                type: "uuid",
                nullable: false,
                default: { kind: "random_uuid" },
              },
            ],
          }),
          {
            idempotencyKey: "v0206-runtime-1",
            commandType: "schema.table.create",
            command: { schema: APP_SCHEMA, table: "runtime_escape" },
            actor: "runtime-lane",
            dryRun: true,
          },
        ),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 })
      expect(await tableExists(APP_SCHEMA, "runtime_escape")).toBe(false)
    } finally {
      await runtimePool.close()
    }
  })

  it("never writes statement text, identifiers, or database errors to logs", () => {
    const logged = logSink.join("\n")
    expect(logged).not.toContain("CREATE TABLE")
    expect(logged).not.toContain("real_notes")
    expect(logged).not.toContain("operator's default")
    expect(logged).not.toContain("already exists")
    expect(logged).not.toContain("42P07")
    expect(logged).toContain("schema_ddl_failed")
  })
})
