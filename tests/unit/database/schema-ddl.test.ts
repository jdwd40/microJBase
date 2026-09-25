// Unit tests for the V02-06 typed DDL compiler and executor.

import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { AppError } from "../../../src/core/index.js"
import {
  MIGRATION_LOCK_KEY_FOR_DISTINCTION,
  SCHEMA_DDL_LOCK_KEY,
  compileCreateTable,
  createSchemaDdlExecutor,
  describePlan,
  translateDdlError,
} from "../../../src/database/index.js"
import type { SchemaOperationLog } from "../../../src/database/index.js"

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
    expect(statement).toContain('"id" uuid NOT NULL DEFAULT gen_random_uuid()')
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

// A scripted pool/client pair for executor behaviour tests.
function createScriptedPool(script: {
  failWith?: unknown
  failAtStatement?: number
}) {
  const calls: string[] = []
  const client = {
    query: async (text: string) => {
      calls.push(text)
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
  return { pool, calls }
}

function createFakeLog(behaviour: {
  outcome?:
    | { kind: "accepted"; id: number }
    | { kind: "replay"; id: number }
    | { kind: "in_progress"; id: number }
  failThrows?: boolean
}) {
  const log: SchemaOperationLog = {
    begin: async () => {
      const kind = behaviour.outcome?.kind ?? "accepted"
      const record = {
        id: behaviour.outcome?.id ?? 1,
        idempotencyKey: "key",
        commandType: "schema.table.create",
        command: {},
        checksum: "x",
        status:
          kind === "replay" ? ("succeeded" as const) : ("running" as const),
        actorFingerprint: "x",
        errorCode: null,
        result: kind === "replay" ? { statementCount: 1 } : null,
        createdAt: new Date(),
        finishedAt: kind === "replay" ? new Date() : null,
      }
      if (kind === "accepted") {
        return { kind: "accepted" as const, record, retryOfFailure: false }
      }
      return { kind, record } as never
    },
    succeed: async (id: number) => ({
      id,
      idempotencyKey: "key",
      commandType: "schema.table.create",
      command: {},
      checksum: "x",
      status: "succeeded" as const,
      actorFingerprint: "x",
      errorCode: null,
      result: null,
      createdAt: new Date(),
      finishedAt: new Date(),
    }),
    fail: behaviour.failThrows
      ? async () => {
          throw new Error("log unavailable")
        }
      : async (id: number) => ({
          id,
          idempotencyKey: "key",
          commandType: "schema.table.create",
          command: {},
          checksum: "x",
          status: "failed" as const,
          actorFingerprint: "x",
          errorCode: "CONFLICT",
          result: null,
          createdAt: new Date(),
          finishedAt: new Date(),
        }),
    get: async () => null,
    list: async () => [],
  }
  const failSpy = vi.spyOn(log, "fail")
  return { log, failSpy }
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
    const { log } = createFakeLog({})
    const loggerLines: string[] = []
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
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
    expect(calls[1]).toContain("pg_advisory_xact_lock")
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
    const { log } = createFakeLog({})
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
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
    const { log } = createFakeLog({ outcome: { kind: "accepted", id: 7 } })
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
    })

    const outcome = await executor.execute(
      compileCreateTable(BASE_SPEC),
      EXEC_OPTIONS,
    )

    expect(outcome.replayed).toBe(false)
    expect(outcome.record?.status).toBe("succeeded")
    expect(calls[0]).toBe("BEGIN")
    expect(calls[1]).toContain("pg_advisory_xact_lock")
    expect(calls[2]).toContain("CREATE TABLE")
    expect(calls.at(-2)).toBe("COMMIT")
  })

  it("replay begin executes nothing", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createFakeLog({ outcome: { kind: "replay", id: 9 } })
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
    })

    const outcome = await executor.execute(
      compileCreateTable(BASE_SPEC),
      EXEC_OPTIONS,
    )

    expect(outcome.replayed).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it("in_progress begin refuses with CONFLICT", async () => {
    const { pool, calls } = createScriptedPool({})
    const { log } = createFakeLog({ outcome: { kind: "in_progress", id: 3 } })
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
    })

    await expect(
      executor.execute(compileCreateTable(BASE_SPEC), EXEC_OPTIONS),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    expect(calls).toHaveLength(0)
  })

  it("failure records the failure and rethrows a redacted error", async () => {
    const { pool } = createScriptedPool({
      failWith: {
        code: "42501",
        message: 'permission denied for table "super_secret_table"',
      },
    })
    const { log, failSpy } = createFakeLog({
      outcome: { kind: "accepted", id: 4 },
    })
    const loggerLines: string[] = []
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
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
    expect(failSpy).toHaveBeenCalledWith(4, "INTERNAL_ERROR")

    // Log redaction: no statement text, no database error text, no secrets.
    const logged = loggerLines.join("\n")
    expect(logged).not.toContain("super_secret_table")
    expect(logged).not.toContain("permission denied")
    expect(logged).not.toContain("CREATE TABLE")
    expect(logged).toContain("schema_ddl_failed")
  })

  it("logs executed operations without statement text or values", async () => {
    const { pool } = createScriptedPool({})
    const { log } = createFakeLog({ outcome: { kind: "accepted", id: 1 } })
    const loggerLines: string[] = []
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
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
    const { log } = createFakeLog({ outcome: { kind: "accepted", id: 1 } })
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
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
    const { log } = createFakeLog({ outcome: { kind: "accepted", id: 1 } })
    const executor = createSchemaDdlExecutor({
      pool: pool as never,
      operationLog: log,
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
