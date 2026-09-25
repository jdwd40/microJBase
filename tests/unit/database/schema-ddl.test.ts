// Unit tests for the V02-06 typed DDL compiler and executor.

import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { AppError } from "../../../src/core/index.js"
import {
  MIGRATION_LOCK_KEY_FOR_DISTINCTION,
  SCHEMA_DDL_LOCK_KEY,
  compileAddColumn,
  compileChangeColumnType,
  compileCreateTable,
  compileDropColumn,
  compileDropColumnDefault,
  compileDropNotNull,
  compileDropTable,
  compileRenameColumn,
  compileRenameTable,
  compileSetColumnDefault,
  compileSetNotNull,
  computeOperationChecksum,
  createSchemaDdlExecutor,
  createSchemaOperationLog,
  describePlan,
  translateDdlError,
} from "../../../src/database/index.js"
import type {
  DdlColumnType,
  SchemaOperationLog,
  SchemaOperationRecord,
} from "../../../src/database/index.js"
import type { JsonValue } from "../../../src/contracts/index.js"

const BASE_SPEC = {
  schema: "app",
  table: "notes",
  columns: [
    {
      name: "id",
      type: "uuid" as const,
      nullable: false,
      default: { kind: "random_uuid" as const },
    },
    {
      name: "title",
      type: "text" as const,
      nullable: false,
      default: { kind: "none" as const },
    },
    {
      name: "created_at",
      type: "timestamptz" as const,
      nullable: false,
      default: { kind: "current_timestamp" as const },
    },
  ],
}

describe("compileCreateTable", () => {
  it("compiles a typed plan with quoted identifiers and allowlisted types", () => {
    const plan = compileCreateTable(BASE_SPEC)
    expect(plan.statements).toHaveLength(1)
    const statement = plan.statements[0] ?? ""
    expect(statement).toContain('CREATE TABLE "app"."notes"')
    expect(statement).toContain(
      '"id" uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid()',
    )
    expect(statement).toContain('"title" text NOT NULL')
    expect(statement).toContain(
      '"created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP',
    )
    expect(plan.description).toBe("create table app.notes with 3 column(s)")
  })

  it("emits nullable columns without NOT NULL", () => {
    const plan = compileCreateTable({
      schema: "app",
      table: "notes",
      columns: [
        {
          name: "body",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      ],
    })
    expect(plan.statements[0]).toContain('"body" text')
    expect(plan.statements[0]).not.toContain("NOT NULL")
  })

  it("refuses internal schemas before any SQL exists", () => {
    for (const schema of [
      "microjbase",
      "pg_catalog",
      "information_schema",
      "pg_toast",
    ]) {
      expect(() =>
        compileCreateTable({
          schema,
          table: "notes",
          columns: [
            {
              name: "id",
              type: "uuid",
              nullable: false,
              default: { kind: "none" },
            },
          ],
        }),
      ).toThrow("Internal schemas cannot be modified")
    }
  })

  it("refuses internal schemas case-insensitively", () => {
    for (const schema of [
      "PG_catalog",
      "MICROJBASE",
      "Information_schema",
      "PG_Temp",
    ]) {
      expect(() =>
        compileCreateTable({
          schema,
          table: "notes",
          columns: [
            {
              name: "id",
              type: "uuid",
              nullable: false,
              default: { kind: "none" },
            },
          ],
        }),
      ).toThrow("Internal schemas cannot be modified")
    }
  })

  it("rejects inherited object properties as column types", () => {
    expect(() =>
      compileCreateTable({
        schema: "app",
        table: "notes",
        columns: [
          {
            name: "payload",
            type: "toString" as never,
            nullable: true,
            default: { kind: "none" },
          },
        ],
      }),
    ).toThrow("is not allowlisted")
  })

  it("enforces the int4 range for integer literal defaults", () => {
    const withInteger = (value: number) =>
      compileCreateTable({
        schema: "app",
        table: "metrics",
        columns: [
          {
            name: "n",
            type: "integer",
            nullable: true,
            default: { kind: "literal", value },
          },
        ],
      })
    expect(withInteger(2_147_483_647).statements[0]).toContain(
      "DEFAULT 2147483647",
    )
    expect(() => withInteger(2_147_483_648)).toThrow("int4")
    expect(() => withInteger(-2_147_483_649)).toThrow("int4")
    // Integer-valued but outside the safe-integer range.
    expect(() => withInteger(1e21)).toThrow("int4")
  })

  it("enforces safe integers and the int8 range for bigint defaults", () => {
    const withBigint = (value: number) =>
      compileCreateTable({
        schema: "app",
        table: "metrics",
        columns: [
          {
            name: "n",
            type: "bigint",
            nullable: true,
            default: { kind: "literal", value },
          },
        ],
      })
    expect(withBigint(9_007_199_254_740_991).statements[0]).toContain(
      "DEFAULT 9007199254740991",
    )
    // 2 ** 63 is integer-valued but outside the safe-integer range, so it
    // cannot be an exact bigint default.
    expect(() => withBigint(2 ** 63)).toThrow("int8")
    expect(() => withBigint(1e21)).toThrow("int8")
  })

  it("renders numeric defaults without an exponent", () => {
    const withNumeric = (value: number) =>
      compileCreateTable({
        schema: "app",
        table: "metrics",
        columns: [
          {
            name: "n",
            type: "numeric",
            nullable: true,
            default: { kind: "literal", value },
          },
        ],
      }).statements[0]
    expect(withNumeric(1e21)).toContain("DEFAULT 1000000000000000000000")
    expect(withNumeric(1e21)).not.toContain("1e+21")
    expect(withNumeric(3.14)).toContain("DEFAULT 3.14")
    expect(withNumeric(1.5e-7)).toContain("DEFAULT 0.00000015")
  })

  it("rejects NUL and backslash characters in text literal defaults", () => {
    const withText = (value: string) =>
      compileCreateTable({
        schema: "app",
        table: "notes",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "literal", value },
          },
        ],
      })
    expect(() => withText("back\\slash")).toThrow("backslash")
    expect(() => withText("nul\0byte")).toThrow("NUL")
  })

  it("qualifies the random uuid default with pg_catalog", () => {
    const plan = compileCreateTable({
      schema: "app",
      table: "notes",
      columns: [
        {
          name: "id",
          type: "uuid",
          nullable: false,
          default: { kind: "random_uuid" },
        },
      ],
    })
    expect(plan.statements[0]).toContain("DEFAULT pg_catalog.gen_random_uuid()")
  })

  it("rejects non-allowlisted column types", () => {
    expect(() =>
      compileCreateTable({
        schema: "app",
        table: "notes",
        columns: [
          {
            name: "payload",
            type: "jsonpath" as never,
            nullable: true,
            default: { kind: "none" },
          },
        ],
      }),
    ).toThrow("is not allowlisted")
  })

  it("rejects empty tables and duplicate column names", () => {
    expect(() =>
      compileCreateTable({ schema: "app", table: "x", columns: [] }),
    ).toThrow("at least one column")
    expect(() =>
      compileCreateTable({
        schema: "app",
        table: "x",
        columns: [
          {
            name: "id",
            type: "uuid",
            nullable: false,
            default: { kind: "none" },
          },
          {
            name: "id",
            type: "text",
            nullable: false,
            default: { kind: "none" },
          },
        ],
      }),
    ).toThrow('duplicate column name "id"')
  })

  it("rejects hostile identifiers", () => {
    for (const name of [
      'evil"; DROP TABLE users',
      "with space",
      "semi;colon",
      "",
    ]) {
      expect(() =>
        compileCreateTable({
          schema: "app",
          table: name,
          columns: [
            {
              name: "id",
              type: "uuid",
              nullable: false,
              default: { kind: "none" },
            },
          ],
        }),
      ).toThrow("Invalid SQL identifier")
    }
  })

  it("escapes quotes in literal defaults", () => {
    const plan = compileCreateTable({
      schema: "app",
      table: "notes",
      columns: [
        {
          name: "title",
          type: "text",
          nullable: false,
          default: { kind: "literal", value: " operator's ``value'' " },
        },
      ],
    })
    expect(plan.statements[0]).toContain(
      "DEFAULT ' operator''s ``value'''' '::text",
    )
    expect(plan.statements[0]).not.toContain(" operator's ")
  })

  it("validates literal defaults per type", () => {
    const specWith = (type: never, value: unknown) =>
      compileCreateTable({
        schema: "app",
        table: "notes",
        columns: [
          {
            name: "c",
            type,
            nullable: true,
            default: { kind: "literal", value: value as never },
          },
        ],
      })

    expect(() => specWith("integer" as never, 1.5)).toThrow("whole numbers")
    expect(() => specWith("bigint" as never, "nope")).toThrow("whole numbers")
    expect(() => specWith("boolean" as never, "true")).toThrow("true or false")
    expect(() => specWith("uuid" as never, "not-a-uuid")).toThrow("UUID")
    expect(() => specWith("date" as never, "2024-13-45")).toThrow(
      "real calendar dates",
    )
    expect(() => specWith("date" as never, "2023-02-29")).toThrow(
      "real calendar dates",
    )
    expect(() => specWith("timestamp" as never, "yesterday")).toThrow(
      "ISO-8601",
    )
    expect(() =>
      specWith("numeric" as never, Number.POSITIVE_INFINITY),
    ).toThrow("finite numbers")
    // jsonb accepts only JSON primitives through the typed template.
    expect(() => specWith("jsonb" as never, { nested: true })).toThrow(
      "jsonb literal defaults must be JSON values",
    )
  })

  it("accepts well-formed literal defaults per type", () => {
    const plan = compileCreateTable({
      schema: "app",
      table: "metrics",
      columns: [
        {
          name: "n",
          type: "integer",
          nullable: true,
          default: { kind: "literal", value: 42 },
        },
        {
          name: "b",
          type: "boolean",
          nullable: true,
          default: { kind: "literal", value: true },
        },
        {
          name: "u",
          type: "uuid",
          nullable: true,
          default: {
            kind: "literal",
            value: "A0EebC99-9C0B-4EF8-BB6D-6BB9BD380A11",
          },
        },
        {
          name: "d",
          type: "date",
          nullable: true,
          default: { kind: "literal", value: "2024-02-29" },
        },
        {
          name: "ts",
          type: "timestamptz",
          nullable: true,
          default: { kind: "literal", value: "2024-01-02T03:04:05Z" },
        },
        {
          name: "j",
          type: "jsonb",
          nullable: true,
          default: { kind: "literal", value: null },
        },
      ],
    })
    const statement = plan.statements[0] ?? ""
    expect(statement).toContain('"n" integer DEFAULT 42')
    expect(statement).toContain('"b" boolean DEFAULT TRUE')
    expect(statement).toContain(
      "\"u\" uuid DEFAULT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid",
    )
    expect(statement).toContain("\"d\" date DEFAULT '2024-02-29'::date")
    expect(statement).toContain("DEFAULT '2024-01-02T03:04:05Z'::timestamptz")
    expect(statement).toContain('"j" jsonb DEFAULT NULL::jsonb')
  })

  it("restricts current_timestamp to timestamp types", () => {
    expect(() =>
      compileCreateTable({
        schema: "app",
        table: "notes",
        columns: [
          {
            name: "c",
            type: "date",
            nullable: true,
            default: { kind: "current_timestamp" },
          },
        ],
      }),
    ).toThrow("current_timestamp defaults are only allowed")
    expect(() =>
      compileCreateTable({
        schema: "app",
        table: "notes",
        columns: [
          {
            name: "c",
            type: "timestamp",
            nullable: true,
            default: { kind: "current_timestamp" },
          },
        ],
      }),
    ).not.toThrow()
  })

  it("restricts random_uuid to uuid columns", () => {
    expect(() =>
      compileCreateTable({
        schema: "app",
        table: "notes",
        columns: [
          {
            name: "c",
            type: "text",
            nullable: true,
            default: { kind: "random_uuid" },
          },
        ],
      }),
    ).toThrow("random_uuid defaults are only allowed")
  })

  it("describePlan exposes the compiled statements for dry-run display", () => {
    const plan = compileCreateTable(BASE_SPEC)
    expect(describePlan(plan)).toEqual(plan.statements)
  })
})

describe("reserved advisory keys", () => {
  it("uses the reserved schema-DDL key distinct from the migration key", () => {
    expect(SCHEMA_DDL_LOCK_KEY).toBe(7_921_890_504_698_152_930n)
    expect(MIGRATION_LOCK_KEY_FOR_DISTINCTION).toBe(7_921_890_504_698_152_929n)
    expect(SCHEMA_DDL_LOCK_KEY).not.toBe(MIGRATION_LOCK_KEY_FOR_DISTINCTION)
  })
})

describe("translateDdlError", () => {
  it("passes AppError through unchanged", () => {
    const error = new AppError("CONFLICT", "Relation already exists", 409)
    expect(translateDdlError(error)).toBe(error)
  })

  it("maps duplicate_table to a safe CONFLICT envelope", () => {
    const mapped = translateDdlError({
      code: "42P07",
      message: 'relation "notes" already exists',
      detail: "internal detail that must not leak",
    })
    expect(mapped).toMatchObject({ code: "CONFLICT", status: 409 })
    expect(mapped.message).toBe("Relation already exists")
    expect(mapped.message).not.toContain("notes")
  })

  it("maps missing schema/table sqlstates to TABLE_NOT_FOUND", () => {
    expect(
      translateDdlError({ code: "3F000", message: "no schema" }),
    ).toMatchObject({ code: "TABLE_NOT_FOUND", status: 404 })
    expect(
      translateDdlError({ code: "42P01", message: "no table" }),
    ).toMatchObject({ code: "TABLE_NOT_FOUND", status: 404 })
  })

  it("maps unique_violation and privilege/deadlock codes safely", () => {
    expect(
      translateDdlError({ code: "23505", message: "duplicate key value" }),
    ).toMatchObject({ code: "CONFLICT", status: 409 })
    expect(
      translateDdlError({
        code: "42501",
        message: 'permission denied for table "secret_name"',
      }),
    ).toMatchObject({ code: "INTERNAL_ERROR", status: 500 })
    expect(
      translateDdlError({ code: "40P01", message: "deadlock detected" }),
    ).toMatchObject({ code: "INTERNAL_ERROR", status: 500 })
  })

  it("never leaks pg internals for unmapped or non-pg errors", () => {
    const unmapped = translateDdlError({
      code: "XX000",
      message: "corrupt internal pg detail",
    })
    expect(unmapped).toMatchObject({ code: "INTERNAL_ERROR", status: 500 })
    expect(unmapped.message).toBe("Schema operation failed")
    expect(unmapped.message).not.toContain("corrupt")

    const plain = translateDdlError(new Error("driver exploded with secrets"))
    expect(plain.message).toBe("Schema operation failed")
    expect(plain.message).not.toContain("driver")
  })
})

// A scripted pool/client pair for executor behaviour tests. Every submitted
// query is recorded together with the protocol mode it was submitted with so
// tests can assert the extended protocol is used for plan statements.
function createScriptedPool(script: {
  failWith?: unknown
  failAtStatement?: number
  throwOn?: (text: string) => unknown
}) {
  const calls: string[] = []
  const modes: Array<string | undefined> = []
  const client = {
    query: async (input: string | { text: string; queryMode?: string }) => {
      const text = typeof input === "string" ? input : input.text
      calls.push(text)
      modes.push(typeof input === "string" ? undefined : input.queryMode)
      if (script.throwOn !== undefined) {
        const thrown = script.throwOn(text)
        if (thrown !== undefined) {
          throw thrown
        }
      }
      if (
        script.failWith !== undefined &&
        calls.filter((c) => c.startsWith("CREATE TABLE")).length ===
          (script.failAtStatement ?? 1)
      ) {
        throw script.failWith
      }
      return { rows: [], rowCount: 0 }
    },
    release: () => {
      calls.push("release")
    },
  }
  const pool = {
    connect: async () => client as unknown as pg.PoolClient,
    query: client.query,
    close: async () => undefined,
    async [Symbol.asyncDispose]() {
      await this.close()
    },
  }
  return { pool, calls, modes }
}

type TrackingEntry = {
  id: number
  checksum: string
  status: "running" | "succeeded" | "failed"
}

function fakeRecord(
  entry: TrackingEntry,
  result: JsonValue | null = null,
): SchemaOperationRecord {
  return {
    id: entry.id,
    idempotencyKey: "key-1",
    commandType: "schema.table.create",
    command: {},
    checksum: entry.checksum,
    status: entry.status,
    actorFingerprint: "x",
    errorCode: null,
    result,
    createdAt: new Date(),
    finishedAt: entry.status === "running" ? null : new Date(),
  }
}

// An in-memory operation log honouring the repository replay contract,
// including the statement-list-aware checksum the executor supplies. The
// executor binds the log to its transaction client, so no SQL reaches the
// scripted pool from here.
function createTrackingLog(options: { succeedThrows?: boolean } = {}) {
  const entries = new Map<string, TrackingEntry>()
  let nextId = 1

  const fail = vi.fn(async (id: number) => {
    const entry = [...entries.values()].find((candidate) => candidate.id === id)
    if (entry === undefined || entry.status !== "running") {
      throw new AppError("INTERNAL_ERROR", "operation is not running", 500)
    }
    entry.status = "failed"
    return fakeRecord(entry)
  })

  const log: SchemaOperationLog = {
    async begin(input) {
      const checksum = computeOperationChecksum(
        input.commandType,
        input.command,
        input.statements,
      )
      const existing = entries.get(input.idempotencyKey)
      if (existing === undefined) {
        const entry: TrackingEntry = {
          id: nextId++,
          checksum,
          status: "running",
        }
        entries.set(input.idempotencyKey, entry)
        return {
          kind: "accepted",
          record: fakeRecord(entry),
          retryOfFailure: false,
        }
      }
      if (existing.checksum !== checksum) {
        throw new AppError(
          "CONFLICT",
          "Idempotency key was already used with a different operation",
          409,
        )
      }
      if (existing.status === "succeeded") {
        return {
          kind: "replay",
          record: fakeRecord(existing, { statementCount: 1 }),
        }
      }
      if (existing.status === "running") {
        return { kind: "in_progress", record: fakeRecord(existing) }
      }
      existing.status = "running"
      return {
        kind: "accepted",
        record: fakeRecord(existing),
        retryOfFailure: true,
      }
    },
    succeed:
      options.succeedThrows === true
        ? vi.fn(async () => {
            throw new Error("log unavailable")
          })
        : vi.fn(async (id: number, result: JsonValue) => {
            const entry = [...entries.values()].find(
              (candidate) => candidate.id === id,
            )
            if (entry === undefined || entry.status !== "running") {
              throw new AppError(
                "INTERNAL_ERROR",
                "operation is not running",
                500,
              )
            }
            entry.status = "succeeded"
            return fakeRecord(entry, result)
          }),
    fail,
    get: async () => null,
    list: async () => [],
  }
  return { log, fail }
}

const EXEC_OPTIONS = {
  idempotencyKey: "key-1",
  commandType: "schema.table.create",
  command: { schema: "app", table: "notes" },
  actor: "operator",
}

describe("createSchemaDdlExecutor", () => {
  it("dry-run executes under the advisory lock and always rolls back", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createTrackingLog()
    const loggerLines: string[] = []
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
      logger: {
        error: () => undefined,
        warn: () => undefined,
        info: (line: string) => loggerLines.push(line),
        debug: () => undefined,
      },
    })

    const outcome = await executor.execute(compileCreateTable(BASE_SPEC), {
      ...EXEC_OPTIONS,
      dryRun: true,
    })

    expect(outcome).toMatchObject({
      dryRun: true,
      replayed: false,
      record: null,
    })
    expect(calls[0]).toBe("BEGIN")
    expect(calls[1]).toContain("set_config")
    expect(calls[2]).toContain("pg_advisory_xact_lock")
    expect(calls.at(-2)).toBe("ROLLBACK")
    expect(calls).not.toContain("COMMIT")
    expect(
      loggerLines.some((line) => line.includes("schema_ddl_dry_run")),
    ).toBe(true)
  })

  it("maps dry-run failures to safe envelopes", async () => {
    const { pool } = createScriptedPool({
      failWith: { code: "42P07", message: 'relation "notes" already exists' },
    })
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })

    await expect(
      executor.execute(compileCreateTable(BASE_SPEC), {
        ...EXEC_OPTIONS,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("accepted begin runs statements in order inside one transaction", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })

    const outcome = await executor.execute(
      compileCreateTable(BASE_SPEC),
      EXEC_OPTIONS,
    )

    expect(outcome.replayed).toBe(false)
    expect(outcome.record?.status).toBe("succeeded")
    expect(calls[0]).toBe("BEGIN")
    expect(calls[1]).toContain("set_config")
    expect(calls[2]).toContain("pg_advisory_xact_lock")
    expect(calls[3]).toContain("CREATE TABLE")
    expect(calls.at(-2)).toBe("COMMIT")
  })

  it("replay begin executes nothing", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })
    await executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS)

    const outcome = await executor.execute(
      compileCreateTable(BASE_SPEC),
      EXEC_OPTIONS,
    )

    expect(outcome.replayed).toBe(true)
    expect(calls.filter((c) => c === "COMMIT")).toHaveLength(1)
  })

  it("in_progress begin refuses with CONFLICT", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })
    await executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS)
    // The tracking log still holds the key in 'running': emulate a stuck
    // legacy row by refusing the restart through a fresh in-progress state.
    const stuckLog: SchemaOperationLog = {
      begin: async () => {
        const record = fakeRecord({ id: 1, checksum: "x", status: "running" })
        return { kind: "in_progress", record }
      },
      succeed: async () => {
        throw new Error("unreachable")
      },
      fail: async () => {
        throw new Error("unreachable")
      },
      get: async () => null,
      list: async () => [],
    }
    const stuckExecutor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => stuckLog,
    })

    await expect(
      stuckExecutor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    expect(calls.filter((c) => c === "COMMIT")).toHaveLength(1)
  })

  it("rejects a hand-built plan that did not come from the compiler", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })
    const forged = {
      statements: ['CREATE TABLE "app"."forged" ("id" uuid)'],
      description: "forged plan",
    }

    await expect(
      executor.execute(forged as never, EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })

  it("rejects a hand-built plan during dry-run before touching the database", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })
    const forged = {
      statements: ['CREATE TABLE "app"."forged" ("id" uuid)'],
      description: "forged plan",
    }

    await expect(
      executor.execute(forged as never, { ...EXEC_OPTIONS, dryRun: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })

  it("submits every plan statement with the extended query protocol", async () => {
    const { pool, calls, modes } = createScriptedPool({})
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })

    await executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS)

    const createIndexes = calls
      .map((text, index) => (text.startsWith("CREATE TABLE") ? index : -1))
      .filter((index) => index >= 0)
    expect(createIndexes).toHaveLength(1)
    for (const index of createIndexes) {
      expect(modes[index]).toBe("extended")
    }
  })

  it("conflicts when a succeeded key replays with a different statement list", async () => {
    const { pool } = createScriptedPool({})
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })
    const firstSpec = { ...BASE_SPEC, table: "one" }
    const secondSpec = { ...BASE_SPEC, table: "two" }

    await executor.execute(compileCreateTable(firstSpec), EXEC_OPTIONS)
    await expect(
      executor.execute(compileCreateTable(secondSpec), EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("rolls back the DDL and the history row when the success update fails", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log, fail } = createTrackingLog({ succeedThrows: true })
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })

    await expect(
      executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 })
    expect(calls).toContain("ROLLBACK")
    expect(calls).not.toContain("COMMIT")
    expect(fail).not.toHaveBeenCalled()
  })

  it("maps lock_timeout (55P03) while waiting on the advisory key to the in-progress conflict", async () => {
    const { pool, calls } = createScriptedPool({
      throwOn: (text) =>
        text.includes("pg_advisory_xact_lock")
          ? { code: "55P03", message: "lock not available" }
          : undefined,
    })
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })

    await expect(
      executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    expect(calls).toContain("ROLLBACK")
    expect(calls).not.toContain("COMMIT")
  })

  it("maps the statement timeout while waiting on the idempotency key to the in-progress conflict", async () => {
    const { pool, calls } = createScriptedPool({
      throwOn: (text) =>
        text.includes("INSERT INTO microjbase.schema_operations")
          ? new Error("Query read timeout")
          : undefined,
    })
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: (query) => createSchemaOperationLog({ query }),
    })

    await expect(
      executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    expect(calls).toContain("ROLLBACK")
    expect(calls).not.toContain("COMMIT")
  })

  it("failure rolls back the DDL and rethrows a redacted error", async () => {
    const { pool } = createScriptedPool({
      failWith: {
        code: "42501",
        message: 'permission denied for table "super_secret_table"',
      },
    })
    const { log, fail } = createTrackingLog()
    const loggerLines: string[] = []
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
      logger: {
        error: () => undefined,
        warn: (line: string) => loggerLines.push(line),
        info: () => undefined,
        debug: () => undefined,
      },
    })

    await expect(
      executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 })
    // The single-transaction design rolls the history row back with the DDL.
    expect(fail).not.toHaveBeenCalled()

    // Log redaction: no statement text, no database error text, no secrets.
    const logged = loggerLines.join("\n")
    expect(logged).not.toContain("super_secret_table")
    expect(logged).not.toContain("permission denied")
    expect(logged).not.toContain("CREATE TABLE")
    expect(logged).toContain("schema_ddl_failed")
  })

  it("logs executed operations without statement text or values", async () => {
    const { pool } = createScriptedPool({})
    const { log } = createTrackingLog()
    const loggerLines: string[] = []
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
      logger: {
        error: () => undefined,
        warn: () => undefined,
        info: (line: string) => loggerLines.push(line),
        debug: () => undefined,
      },
    })

    await executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS)
    const logged = loggerLines.join("\n")
    expect(logged).toContain("schema_ddl_executed")
    expect(logged).not.toContain("CREATE TABLE")
    expect(logged).not.toContain("notes")
  })

  it("supports multiple plans in one transaction", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })

    const first = compileCreateTable({
      schema: "app",
      table: "one",
      columns: [
        {
          name: "id",
          type: "uuid",
          nullable: false,
          default: { kind: "random_uuid" },
        },
      ],
    })
    const second = compileCreateTable({
      schema: "app",
      table: "two",
      columns: [
        {
          name: "id",
          type: "uuid",
          nullable: false,
          default: { kind: "random_uuid" },
        },
      ],
    })

    await executor.execute([first, second], EXEC_OPTIONS)
    const creates = calls.filter((c) => c.startsWith("CREATE TABLE"))
    expect(creates).toHaveLength(2)
    expect(calls.at(-2)).toBe("COMMIT")
    expect(calls[0]).toBe("BEGIN")
  })

  it("rolls back every statement when a later plan fails", async () => {
    const { pool, calls } = createScriptedPool({
      failWith: { code: "42P07", message: "relation exists" },
      failAtStatement: 2,
    })
    const { log } = createTrackingLog()
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      createOperationLog: () => log,
    })

    const first = compileCreateTable({
      schema: "app",
      table: "one",
      columns: [
        {
          name: "id",
          type: "uuid",
          nullable: false,
          default: { kind: "random_uuid" },
        },
      ],
    })
    const second = compileCreateTable({
      schema: "app",
      table: "two",
      columns: [
        {
          name: "id",
          type: "uuid",
          nullable: false,
          default: { kind: "random_uuid" },
        },
      ],
    })

    await expect(
      executor.execute([first, second], EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(calls.at(-2)).toBe("ROLLBACK")
    expect(calls).not.toContain("COMMIT")
  })
})

describe("V02-07..V02-09 table and column builders", () => {
  it("compileRenameTable renders a quoted RENAME TO", () => {
    const plan = compileRenameTable({
      schema: "app",
      table: "notes",
      newName: "documents",
    })
    expect(plan.statements).toEqual([
      'ALTER TABLE "app"."notes" RENAME TO "documents"',
    ])
    expect(plan.description).toBe("rename table app.notes to documents")
  })

  it("compileRenameTable refuses internal schemas and hostile names", () => {
    expect(() =>
      compileRenameTable({
        schema: "microjbase",
        table: "notes",
        newName: "documents",
      }),
    ).toThrow("Internal schemas cannot be modified")
    expect(() =>
      compileRenameTable({
        schema: "PG_catalog",
        table: "notes",
        newName: "documents",
      }),
    ).toThrow("Internal schemas cannot be modified")
    expect(() =>
      compileRenameTable({
        schema: "app",
        table: 'notes"; DROP TABLE users; --',
        newName: "documents",
      }),
    ).toThrow("Invalid SQL identifier")
    expect(() =>
      compileRenameTable({
        schema: "app",
        table: "notes",
        newName: "bad name",
      }),
    ).toThrow("Invalid SQL identifier")
  })

  it("compileDropTable renders a quoted DROP TABLE without CASCADE", () => {
    const plan = compileDropTable({ schema: "app", table: "notes" })
    expect(plan.statements).toEqual(['DROP TABLE "app"."notes"'])
    expect(plan.statements[0]).not.toContain("CASCADE")
    expect(() =>
      compileDropTable({ schema: "pg_temp", table: "notes" }),
    ).toThrow("Internal schemas cannot be modified")
  })

  it("compileAddColumn renders type, nullability, and template defaults", () => {
    const plan = compileAddColumn({
      schema: "app",
      table: "notes",
      column: {
        name: "priority",
        type: "integer",
        nullable: false,
        default: { kind: "literal", value: 0 },
      },
    })
    expect(plan.statements).toEqual([
      'ALTER TABLE "app"."notes" ADD COLUMN "priority" integer NOT NULL DEFAULT 0',
    ])
  })

  it("compileAddColumn renders nullable columns without NOT NULL", () => {
    const plan = compileAddColumn({
      schema: "app",
      table: "notes",
      column: {
        name: "archived_at",
        type: "timestamptz",
        nullable: true,
        default: { kind: "current_timestamp" },
      },
    })
    expect(plan.statements[0]).toBe(
      'ALTER TABLE "app"."notes" ADD COLUMN "archived_at" timestamptz DEFAULT CURRENT_TIMESTAMP',
    )
  })

  it("compileAddColumn enforces the type allowlist and template guards", () => {
    expect(() =>
      compileAddColumn({
        schema: "app",
        table: "notes",
        column: {
          name: "payload",
          type: "interval" as never,
          nullable: true,
          default: { kind: "none" },
        },
      }),
    ).toThrow('column type "interval" is not allowlisted')
    expect(() =>
      compileAddColumn({
        schema: "app",
        table: "notes",
        column: {
          name: "title",
          type: "text",
          nullable: true,
          default: { kind: "random_uuid" },
        },
      }),
    ).toThrow("random_uuid defaults are only allowed for uuid columns")
  })

  it("compileAddColumn supports the managed primary key flag", () => {
    const plan = compileAddColumn({
      schema: "app",
      table: "notes",
      column: {
        name: "id",
        type: "uuid",
        nullable: false,
        default: { kind: "random_uuid" },
        primaryKey: true,
      },
    })
    expect(plan.statements[0]).toContain(
      '"id" uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid() PRIMARY KEY',
    )
  })

  it("compileRenameColumn and compileDropColumn render quoted column names", () => {
    expect(
      compileRenameColumn({
        schema: "app",
        table: "notes",
        column: "title",
        newName: "heading",
      }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" RENAME COLUMN "title" TO "heading"'])
    expect(
      compileDropColumn({ schema: "app", table: "notes", column: "title" })
        .statements,
    ).toEqual(['ALTER TABLE "app"."notes" DROP COLUMN "title"'])
    expect(() =>
      compileDropColumn({
        schema: "information_schema",
        table: "notes",
        column: "title",
      }),
    ).toThrow("Internal schemas cannot be modified")
  })

  it("compileSetColumnDefault renders SET DEFAULT from the typed templates", () => {
    const plan = compileSetColumnDefault({
      schema: "app",
      table: "notes",
      column: "created_at",
      type: "timestamptz",
      default: { kind: "current_timestamp" },
    })
    expect(plan.statements).toEqual([
      'ALTER TABLE "app"."notes" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP',
    ])
  })

  it("compileSetColumnDefault refuses a missing default and template mismatches", () => {
    expect(() =>
      compileSetColumnDefault({
        schema: "app",
        table: "notes",
        column: "title",
        type: "text",
        default: { kind: "none" },
      }),
    ).toThrow("a default value is required to set a column default")
    expect(() =>
      compileSetColumnDefault({
        schema: "app",
        table: "notes",
        column: "title",
        type: "text",
        default: { kind: "current_timestamp" },
      }),
    ).toThrow(
      "current_timestamp defaults are only allowed for timestamp and timestamptz columns",
    )
    expect(() =>
      compileSetColumnDefault({
        schema: "app",
        table: "notes",
        column: "ref",
        type: "uuid",
        default: { kind: "literal", value: "not-a-uuid" },
      }),
    ).toThrow("uuid literal defaults must be UUID strings")
  })

  it("compileDropColumnDefault, compileSetNotNull, and compileDropNotNull render single commands", () => {
    expect(
      compileDropColumnDefault({
        schema: "app",
        table: "notes",
        column: "title",
      }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" ALTER COLUMN "title" DROP DEFAULT'])
    expect(
      compileSetNotNull({
        schema: "app",
        table: "notes",
        column: "title",
      }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" ALTER COLUMN "title" SET NOT NULL'])
    expect(
      compileDropNotNull({
        schema: "app",
        table: "notes",
        column: "title",
      }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" ALTER COLUMN "title" DROP NOT NULL'])
  })

  it("compileChangeColumnType compiles only matrix-approved conversions", () => {
    expect(
      compileChangeColumnType({
        schema: "app",
        table: "notes",
        column: "priority",
        fromType: "integer",
        toType: "bigint",
      }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" ALTER COLUMN "priority" TYPE bigint'])
    expect(
      compileChangeColumnType({
        schema: "app",
        table: "notes",
        column: "due_on",
        fromType: "date",
        toType: "timestamp",
      }).statements,
    ).toEqual([
      'ALTER TABLE "app"."notes" ALTER COLUMN "due_on" TYPE timestamp',
    ])
  })

  it("compileChangeColumnType refuses pairs outside the frozen matrix", () => {
    const pairs: readonly (readonly [DdlColumnType, DdlColumnType])[] = [
      ["text", "uuid"],
      ["uuid", "text"],
      ["timestamp", "timestamptz"],
      ["timestamptz", "timestamp"],
      ["boolean", "text"],
      ["jsonb", "text"],
      ["numeric", "integer"],
      ["integer", "integer"],
    ]
    for (const [fromType, toType] of pairs) {
      expect(() =>
        compileChangeColumnType({
          schema: "app",
          table: "notes",
          column: "value",
          fromType,
          toType,
        }),
      ).toThrow(
        `type conversion from ${fromType} to ${toType} is not in the safe conversion matrix`,
      )
    }
  })
})
