// Unit tests for the V02-07..V02-09 typed mutation command service. The
// catalogue reader, exposure registry, preflight pool, and the V02-06
// executor are injected fakes, so these tests pin the guard matrix and the
// compiled statement shapes without a database.

import { describe, expect, it } from "vitest"

import type {
  SchemaCatalogue,
  SchemaCatalogueColumn,
  SchemaCatalogueSchema,
  SchemaCatalogueTable,
  TypeIdentity,
} from "../../../src/contracts/index.js"
import {
  createSchemaMutationService,
  mapCatalogueType,
  type ExecuteOutcome,
  type ManagedColumnSpec,
  type SchemaDdlExecutor,
} from "../../../src/database/index.js"
import type {
  Pool,
  SchemaMutationServiceDependencies,
} from "../../../src/database/index.js"

const APP_SCHEMA = "app"
const ADMIN_ROLE = "mjb_admin"

const TEXT_COLUMN_SPEC: ManagedColumnSpec = {
  name: "title",
  type: "text",
  nullable: false,
  default: { kind: "none" },
}

function typeIdentity(name: string): TypeIdentity {
  return { schema: "pg_catalog", name, kind: "base" }
}

interface ColumnOptions {
  readonly isNullable?: boolean
  readonly defaultExpression?: string | null
  readonly generated?: "none" | "stored" | "virtual"
  readonly identity?: "none" | "always" | "by_default"
  readonly renderedType?: string
}

function column(
  name: string,
  options: ColumnOptions = {},
): SchemaCatalogueColumn {
  const renderedType = options.renderedType ?? "text"
  return {
    ordinal: 1,
    name,
    isNullable: options.isNullable ?? true,
    defaultExpression: options.defaultExpression ?? null,
    generated: options.generated ?? "none",
    identity: options.identity ?? "none",
    renderedType,
    type: typeIdentity(
      renderedType === "timestamp without time zone"
        ? "timestamp"
        : renderedType === "timestamp with time zone"
          ? "timestamptz"
          : renderedType,
    ),
    baseType: null,
  }
}

interface TableOptions {
  readonly owner?: string
  readonly columns?: readonly SchemaCatalogueColumn[]
  readonly constraints?: readonly SchemaCatalogueTable["constraints"][number][]
  readonly indexes?: readonly SchemaCatalogueTable["indexes"][number][]
}

function table(name: string, options: TableOptions = {}): SchemaCatalogueTable {
  return {
    schema: APP_SCHEMA,
    name,
    owner: options.owner ?? ADMIN_ROLE,
    kind: "regular",
    hasRowSecurity: false,
    hasForcedRowSecurity: false,
    columns: options.columns ?? [
      column("id", { isNullable: false, renderedType: "uuid" }),
      column("title", { isNullable: false }),
    ],
    constraints: options.constraints ?? [
      {
        name: `${name}_pkey`,
        classification: "primary_key",
        columns: ["id"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
    ],
    indexes: options.indexes ?? [],
  }
}

function catalogue(
  ...schemas: readonly (readonly SchemaCatalogueTable[])[]
): SchemaCatalogue {
  const built: SchemaCatalogueSchema[] = schemas.map((tables, index) => ({
    name: index === 0 ? APP_SCHEMA : `app${String(index)}`,
    owner: ADMIN_ROLE,
    tables,
  }))
  return { schemas: built }
}

interface CapturedCall {
  readonly plan: unknown
  readonly options: {
    readonly idempotencyKey: string
    readonly commandType: string
    readonly command: unknown
    readonly actor: string
    readonly dryRun?: boolean
  }
}

function fakeExecutor() {
  const calls: CapturedCall[] = []
  const outcome: ExecuteOutcome = {
    dryRun: false,
    replayed: false,
    record: null,
  }
  const executor: SchemaDdlExecutor = {
    async execute(plan, options) {
      calls.push({ plan, options })
      return outcome
    },
  }
  return { calls, executor }
}

function fakePool(holds: { rows: boolean; nulls: boolean }): Pool {
  return {
    query: async (text: string) => {
      if (text.includes("has_rows")) {
        return { rows: [{ has_rows: holds.rows }] } as never
      }
      if (text.includes("has_nulls")) {
        return { rows: [{ has_nulls: holds.nulls }] } as never
      }
      if (text.includes("FROM microjbase.schema_operations")) {
        // The replay-first probe always answers "no record" here; the
        // replay-bypass test swaps in a seeded pool below.
        return { rows: [] } as never
      }
      throw new Error(`unexpected preflight query: ${text}`)
    },
  } as unknown as Pool
}

function exposedRegistry(schema: string, table: string) {
  return {
    get: () => null,
    list: () => [
      {
        alias: "alias",
        schema,
        table,
        primaryKey: "id" as const,
        readableColumns: ["id"],
        insertableColumns: ["id"],
        updatableColumns: ["id"],
      },
    ],
  }
}

const INERT_REGISTRY = { get: () => null, list: () => [] }

function makeService(
  overrides: Omit<
    Partial<SchemaMutationServiceDependencies>,
    "catalogue" | "executor"
  > & {
    catalogue: SchemaCatalogue
    executor?: SchemaDdlExecutor
  },
) {
  const { catalogue, executor: overrideExecutor, ...rest } = overrides
  const { calls, executor } = fakeExecutor()
  const service = createSchemaMutationService({
    pool: fakePool({ rows: false, nulls: false }),
    registry: INERT_REGISTRY,
    adminRole: ADMIN_ROLE,
    ...rest,
    catalogue: { read: async () => catalogue },
    executor: overrideExecutor ?? executor,
  })
  return { service, calls }
}

function rejection(
  promise: Promise<unknown>,
): Promise<Record<string, unknown>> {
  return promise.then(
    () => {
      throw new Error("expected the command to be rejected")
    },
    (error: unknown) => error as Record<string, unknown>,
  )
}

describe("mapCatalogueType", () => {
  it("maps exact allowlisted renderings and refuses everything else", () => {
    expect(mapCatalogueType("text")).toBe("text")
    expect(mapCatalogueType("integer")).toBe("integer")
    expect(mapCatalogueType("bigint")).toBe("bigint")
    expect(mapCatalogueType("boolean")).toBe("boolean")
    expect(mapCatalogueType("uuid")).toBe("uuid")
    expect(mapCatalogueType("date")).toBe("date")
    expect(mapCatalogueType("numeric")).toBe("numeric")
    expect(mapCatalogueType("jsonb")).toBe("jsonb")
    expect(mapCatalogueType("timestamp without time zone")).toBe("timestamp")
    expect(mapCatalogueType("timestamp with time zone")).toBe("timestamptz")
    expect(mapCatalogueType("character varying(30)")).toBeNull()
    expect(mapCatalogueType("text[]")).toBeNull()
    expect(mapCatalogueType("numeric(10,2)")).toBeNull()
    expect(mapCatalogueType("app.status")).toBeNull()
  })
})

describe("createTable", () => {
  it("compiles the managed id primary key and the operator columns", async () => {
    const { service, calls } = makeService({ catalogue: catalogue([]) })
    const outcome = await service.createTable({
      idempotencyKey: "k1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      columns: [
        {
          name: "title",
          type: "text",
          nullable: false,
          default: { kind: "none" },
        },
      ],
    })
    expect(outcome.replayed).toBe(false)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.options.commandType).toBe("schema.table.create")
    expect(call?.options.command).toEqual({
      schema: APP_SCHEMA,
      table: "notes",
      columns: [
        {
          name: "title",
          type: "text",
          nullable: false,
          default: { kind: "none" },
        },
      ],
    })
    const plan = call?.plan as { statements: readonly string[] }
    expect(plan.statements[0]).toContain(
      '"id" uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid() PRIMARY KEY',
    )
    expect(plan.statements[0]).toContain('"title" text NOT NULL')
  })

  it("passes dryRun through to the executor", async () => {
    const { service, calls } = makeService({ catalogue: catalogue([]) })
    await service.createTable({
      idempotencyKey: "k-dry",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      columns: [
        {
          name: "title",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      ],
      dryRun: true,
    })
    expect(calls[0]?.options.dryRun).toBe(true)
  })

  it("refuses internal schemas, missing schemas, and existing tables", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
    })

    const internal = await rejection(
      service.createTable({
        idempotencyKey: "k2",
        actor: "operator",
        schema: "microjbase",
        table: "notes",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      }),
    )
    expect(internal).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const caseVariant = await rejection(
      service.createTable({
        idempotencyKey: "k2b",
        actor: "operator",
        schema: "PG_catalog",
        table: "notes",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      }),
    )
    expect(caseVariant).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const missing = await rejection(
      service.createTable({
        idempotencyKey: "k3",
        actor: "operator",
        schema: "missing",
        table: "notes",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      }),
    )
    expect(missing).toMatchObject({ code: "TABLE_NOT_FOUND", status: 404 })

    const existing = await rejection(
      service.createTable({
        idempotencyKey: "k4",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      }),
    )
    expect(existing).toMatchObject({ code: "CONFLICT", status: 409 })
    expect(calls).toHaveLength(0)
  })

  it("refuses reserved names, empty column lists, and operator id columns", async () => {
    const { service, calls } = makeService({ catalogue: catalogue([]) })

    const reserved = await rejection(
      service.createTable({
        idempotencyKey: "k5",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "pg_stat_notes",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      }),
    )
    expect(reserved).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const empty = await rejection(
      service.createTable({
        idempotencyKey: "k6",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        columns: [],
      }),
    )
    expect(empty).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    for (const name of ["id", "ID", "Id"]) {
      const idColumn = await rejection(
        service.createTable({
          idempotencyKey: `k7-${name}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "notes",
          columns: [
            { name, type: "text", nullable: true, default: { kind: "none" } },
          ],
        }),
      )
      expect(idColumn).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    }

    const hostile = await rejection(
      service.createTable({
        idempotencyKey: "k8",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        columns: [
          {
            name: 'title"; DROP TABLE users; --',
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      }),
    )
    expect(hostile).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })
})

describe("replay-first preflight bypass", () => {
  const seededRecord = {
    id: "1",
    idempotency_key: "replay-key",
    command_type: "schema.table.create",
    command: { schema: "app", table: "notes" },
    checksum: "c".repeat(64),
    status: "succeeded",
    actor_fingerprint: "f".repeat(64),
    error_code: null,
    result: null,
    created_at: new Date("2026-09-25T00:00:00.000Z"),
    finished_at: new Date("2026-09-25T00:00:01.000Z"),
  }

  function seededPool(): Pool {
    return {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("FROM microjbase.schema_operations")) {
          return {
            rows: values?.[0] === "replay-key" ? [seededRecord] : [],
          } as never
        }
        if (text.includes("has_rows") || text.includes("has_nulls")) {
          return { rows: [{ has_rows: false, has_nulls: false }] } as never
        }
        throw new Error(`unexpected preflight query: ${text}`)
      },
    } as unknown as Pool
  }

  it("hands a known key to the executor even when stateful guards would refuse", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
      pool: seededPool(),
    })
    const outcome = await service.createTable({
      idempotencyKey: "replay-key",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      columns: [TEXT_COLUMN_SPEC],
    })
    expect(outcome.replayed).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.commandType).toBe("schema.table.create")
  })

  it("skips the drop confirmation check on the replay path", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
      pool: seededPool(),
    })
    await service.dropTable({
      idempotencyKey: "replay-key",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      confirm: "not-the-right-value",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.commandType).toBe("schema.table.drop")
  })
})

describe("renameTable", () => {
  it("renames an owned, unexposed table", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
    })
    await service.renameTable({
      idempotencyKey: "r1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      newName: "documents",
    })
    const call = calls[0]
    expect(call?.options.commandType).toBe("schema.table.rename")
    expect(
      (call?.plan as { statements: readonly string[] }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" RENAME TO "documents"'])
    expect(call?.options.command).toEqual({
      schema: APP_SCHEMA,
      table: "notes",
      newName: "documents",
    })
  })

  it("refuses missing, foreign-owned, exposed, and colliding targets", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([
        table("notes"),
        table("documents"),
        table("foreign", { owner: "someone_else" }),
      ]),
      registry: exposedRegistry(APP_SCHEMA, "notes"),
    })

    const missing = await rejection(
      service.renameTable({
        idempotencyKey: "r2",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "missing",
        newName: "documents",
      }),
    )
    expect(missing).toMatchObject({ code: "TABLE_NOT_FOUND", status: 404 })

    const exposed = await rejection(
      service.renameTable({
        idempotencyKey: "r3",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        newName: "notes2",
      }),
    )
    expect(exposed).toMatchObject({ code: "CONFLICT", status: 409 })

    const foreign = await rejection(
      service.renameTable({
        idempotencyKey: "r4",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "foreign",
        newName: "foreign2",
      }),
    )
    expect(foreign).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const collision = await rejection(
      service.renameTable({
        idempotencyKey: "r5",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        newName: "documents",
      }),
    )
    expect(collision).toMatchObject({ code: "CONFLICT", status: 409 })
    expect(calls).toHaveLength(0)
  })
})

describe("dropTable", () => {
  it("drops an owned, unexposed table with the exact confirmation", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
    })
    await service.dropTable({
      idempotencyKey: "d1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      confirm: "app.notes",
    })
    const call = calls[0]
    expect(call?.options.commandType).toBe("schema.table.drop")
    expect(call?.options.command).toEqual({
      schema: APP_SCHEMA,
      table: "notes",
      confirmed: true,
    })
    expect(
      (call?.plan as { statements: readonly string[] }).statements,
    ).toEqual(['DROP TABLE "app"."notes"'])
  })

  it("refuses without the exact confirmation value", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
    })
    for (const confirm of ["notes", "app.notes ", "APP.NOTES", "app.notes2"]) {
      const error = await rejection(
        service.dropTable({
          idempotencyKey: `d2-${confirm}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "notes",
          confirm,
        }),
      )
      expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    }
    expect(calls).toHaveLength(0)
  })

  it("refuses exposed tables and tables referenced by foreign keys", async () => {
    const referencingConstraint: SchemaCatalogueTable["constraints"][number] = {
      name: "child_ref_fkey",
      classification: "foreign_key",
      columns: ["ref"],
      references: { schema: APP_SCHEMA, table: "parent", columns: ["id"] },
      onUpdate: "no_action",
      onDelete: "no_action",
    }
    const { service, calls } = makeService({
      catalogue: catalogue([
        table("parent"),
        table("child", {
          columns: [
            column("id", { isNullable: false, renderedType: "uuid" }),
            column("ref", { isNullable: true, renderedType: "uuid" }),
          ],
          constraints: [referencingConstraint],
        }),
      ]),
    })

    const referenced = await rejection(
      service.dropTable({
        idempotencyKey: "d3",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "parent",
        confirm: "app.parent",
      }),
    )
    expect(referenced).toMatchObject({ code: "CONFLICT", status: 409 })

    await service.dropTable({
      idempotencyKey: "d4",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "child",
      confirm: "app.child",
    })
    expect(calls).toHaveLength(1)
  })
})

describe("addColumn", () => {
  it("adds a column to an owned, unexposed table", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
    })
    await service.addColumn({
      idempotencyKey: "a1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: {
        name: "priority",
        type: "integer",
        nullable: false,
        default: { kind: "literal", value: 0 },
      },
    })
    const call = calls[0]
    expect(call?.options.commandType).toBe("schema.column.add")
    expect(
      (call?.plan as { statements: readonly string[] }).statements[0],
    ).toBe(
      'ALTER TABLE "app"."notes" ADD COLUMN "priority" integer NOT NULL DEFAULT 0',
    )
  })

  it("refuses duplicate columns, the id name, and NOT NULL without default on populated tables", async () => {
    const populatedPool = fakePool({ rows: true, nulls: false })
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
      pool: populatedPool,
    })

    const duplicate = await rejection(
      service.addColumn({
        idempotencyKey: "a2",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: {
          name: "title",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      }),
    )
    expect(duplicate).toMatchObject({ code: "CONFLICT", status: 409 })

    const idColumn = await rejection(
      service.addColumn({
        idempotencyKey: "a3",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: {
          name: "id",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      }),
    )
    expect(idColumn).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const notNullNoDefault = await rejection(
      service.addColumn({
        idempotencyKey: "a4",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: {
          name: "priority",
          type: "integer",
          nullable: false,
          default: { kind: "none" },
        },
      }),
    )
    expect(notNullNoDefault).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })
    expect(calls).toHaveLength(0)
  })

  it("allows NOT NULL without default on an empty table", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
    })
    await service.addColumn({
      idempotencyKey: "a5",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: {
        name: "priority",
        type: "integer",
        nullable: false,
        default: { kind: "none" },
      },
    })
    expect(calls).toHaveLength(1)
  })
})

describe("renameColumn", () => {
  const guardedCatalogue = catalogue([
    table("notes", {
      columns: [
        column("id", { isNullable: false, renderedType: "uuid" }),
        column("title"),
        column("computed", { generated: "stored" }),
        column("serial_no", { identity: "always" }),
      ],
    }),
  ])

  it("renames a plain column", async () => {
    const { service, calls } = makeService({ catalogue: guardedCatalogue })
    await service.renameColumn({
      idempotencyKey: "rc1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "title",
      newName: "heading",
    })
    expect(calls[0]?.options.commandType).toBe("schema.column.rename")
    expect(
      (calls[0]?.plan as { statements: readonly string[] }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" RENAME COLUMN "title" TO "heading"'])
  })

  it("refuses generated, identity, primary-key, and id-named targets", async () => {
    const { service, calls } = makeService({ catalogue: guardedCatalogue })

    for (const [columnName, key] of [
      ["computed", "generated"],
      ["serial_no", "identity"],
      ["id", "primary-key"],
    ] as const) {
      const error = await rejection(
        service.renameColumn({
          idempotencyKey: `rc2-${key}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "notes",
          column: columnName,
          newName: "heading",
        }),
      )
      expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    }

    const idTarget = await rejection(
      service.renameColumn({
        idempotencyKey: "rc3",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "title",
        newName: "id",
      }),
    )
    expect(idTarget).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })
})

describe("dropColumn", () => {
  const dependentIndex: SchemaCatalogueTable["indexes"][number] = {
    name: "notes_title_idx",
    classification: "index",
    isUnique: false,
    isExpression: false,
    hasPredicate: false,
    columns: ["title"],
  }

  it("drops a plain column with the exact confirmation", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
    })
    await service.dropColumn({
      idempotencyKey: "dc1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "title",
      confirm: "app.notes.title",
    })
    expect(calls[0]?.options.commandType).toBe("schema.column.drop")
    expect(
      (calls[0]?.plan as { statements: readonly string[] }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" DROP COLUMN "title"'])
  })

  it("refuses without the exact confirmation value", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
    })
    const error = await rejection(
      service.dropColumn({
        idempotencyKey: "dc2",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "title",
        confirm: "title",
      }),
    )
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })

  it("refuses safeguarded and dependent columns", async () => {
    const { service, calls } = makeService({
      catalogue: catalogue([
        table("notes", {
          columns: [
            column("id", { isNullable: false, renderedType: "uuid" }),
            column("title"),
            column("computed", { generated: "stored" }),
          ],
          indexes: [dependentIndex],
        }),
      ]),
    })

    for (const [columnName, key] of [
      ["id", "pk"],
      ["computed", "generated"],
      ["title", "dependent"],
    ] as const) {
      const error = await rejection(
        service.dropColumn({
          idempotencyKey: `dc3-${key}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "notes",
          column: columnName,
          confirm: `app.notes.${columnName}`,
        }),
      )
      expect(error).toMatchObject({
        code: key === "dependent" ? "CONFLICT" : "VALIDATION_ERROR",
        status: key === "dependent" ? 409 : 400,
      })
    }
    expect(calls).toHaveLength(0)
  })
})

describe("column defaults, nullability, and type changes", () => {
  function typedTable(columns: readonly SchemaCatalogueColumn[]) {
    return catalogue([table("notes", { columns })])
  }

  it("sets a default through the typed templates", async () => {
    const { service, calls } = makeService({
      catalogue: typedTable([
        column("id", { isNullable: false, renderedType: "uuid" }),
        column("title"),
      ]),
    })
    await service.setColumnDefault({
      idempotencyKey: "sd1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "title",
      default: { kind: "literal", value: "untitled" },
    })
    expect(calls[0]?.options.commandType).toBe("schema.column.default.set")
    expect(
      (calls[0]?.plan as { statements: readonly string[] }).statements,
    ).toEqual([
      'ALTER TABLE "app"."notes" ALTER COLUMN "title" SET DEFAULT \'untitled\'::text',
    ])
  })

  it("refuses defaults on generated or unmanageable-type columns", async () => {
    const { service, calls } = makeService({
      catalogue: typedTable([
        column("id", { isNullable: false, renderedType: "uuid" }),
        column("body"),
        column("computed", { generated: "stored" }),
        column("amount", { renderedType: "numeric(10,2)" }),
      ]),
    })

    const generated = await rejection(
      service.setColumnDefault({
        idempotencyKey: "sd2",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "computed",
        default: { kind: "literal", value: 1 },
      }),
    )
    expect(generated).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const unmanageable = await rejection(
      service.setColumnDefault({
        idempotencyKey: "sd3",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "amount",
        default: { kind: "literal", value: 1 },
      }),
    )
    expect(unmanageable).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })

    const mismatched = await rejection(
      service.setColumnDefault({
        idempotencyKey: "sd4",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "body",
        default: { kind: "random_uuid" },
      }),
    )
    expect(mismatched).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })

  it("drops a default and toggles nullability with preflight checks", async () => {
    const nullsPool = fakePool({ rows: false, nulls: true })
    const { service, calls } = makeService({
      catalogue: typedTable([
        column("id", { isNullable: false, renderedType: "uuid" }),
        column("title", { defaultExpression: "'untitled'::text" }),
      ]),
      pool: nullsPool,
    })

    await service.dropColumnDefault({
      idempotencyKey: "dd1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "title",
    })
    expect(calls[0]?.options.commandType).toBe("schema.column.default.drop")

    const hasNulls = await rejection(
      service.setColumnNotNull({
        idempotencyKey: "nn1",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "title",
      }),
    )
    expect(hasNulls).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    await service.dropColumnNotNull({
      idempotencyKey: "nn2",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "title",
    })
    expect(calls[1]?.options.commandType).toBe("schema.column.not_null.drop")
  })

  it("allows SET NOT NULL when no NULL values exist", async () => {
    const { service, calls } = makeService({
      catalogue: typedTable([
        column("id", { isNullable: false, renderedType: "uuid" }),
        column("title", { isNullable: true }),
      ]),
    })
    await service.setColumnNotNull({
      idempotencyKey: "nn3",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "title",
    })
    expect(
      (calls[0]?.plan as { statements: readonly string[] }).statements,
    ).toEqual(['ALTER TABLE "app"."notes" ALTER COLUMN "title" SET NOT NULL'])
  })

  it("changes a type only within the frozen matrix", async () => {
    const { service, calls } = makeService({
      catalogue: typedTable([
        column("id", { isNullable: false, renderedType: "uuid" }),
        column("priority", { isNullable: false, renderedType: "integer" }),
      ]),
    })
    await service.changeColumnType({
      idempotencyKey: "ct1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "priority",
      toType: "bigint",
    })
    const call = calls[0]
    expect(call?.options.commandType).toBe("schema.column.type.change")
    expect(call?.options.command).toEqual({
      schema: APP_SCHEMA,
      table: "notes",
      column: "priority",
      fromType: "integer",
      toType: "bigint",
    })
    const statements = (call?.plan as { statements: readonly string[] })
      .statements
    expect(statements[1]).toBe(
      'ALTER TABLE "app"."notes" ALTER COLUMN "priority" TYPE bigint',
    )
    expect(statements[0]).toContain("format_type(")
  })

  it("refuses type changes with defaults, dependencies, or outside the matrix", async () => {
    const { service, calls } = makeService({
      catalogue: typedTable([
        column("id", { isNullable: false, renderedType: "uuid" }),
        column("priority", {
          isNullable: false,
          renderedType: "integer",
          defaultExpression: "0",
        }),
        column("plain", { isNullable: false, renderedType: "integer" }),
      ]),
    })

    const withDefault = await rejection(
      service.changeColumnType({
        idempotencyKey: "ct2",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "priority",
        toType: "bigint",
      }),
    )
    expect(withDefault).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })

    const outsideMatrix = await rejection(
      service.changeColumnType({
        idempotencyKey: "ct3",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "plain",
        toType: "uuid",
      }),
    )
    expect(outsideMatrix).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })
    expect(calls).toHaveLength(0)
  })
})

describe("safeguarded default commands", () => {
  const guardedCatalogue = catalogue([
    table("notes", {
      columns: [
        column("id", { isNullable: false, renderedType: "uuid" }),
        column("title"),
        column("computed", { generated: "stored" }),
        column("serial_no", { identity: "always" }),
      ],
    }),
  ])

  it("setColumnDefault refuses generated and identity columns", async () => {
    const { service, calls } = makeService({ catalogue: guardedCatalogue })

    for (const [columnName, key] of [
      ["computed", "generated"],
      ["serial_no", "identity"],
    ] as const) {
      const error = await rejection(
        service.setColumnDefault({
          idempotencyKey: `sd-${key}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "notes",
          column: columnName,
          default: { kind: "literal", value: 1 },
        }),
      )
      expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    }
    expect(calls).toHaveLength(0)
  })

  it("dropColumnDefault refuses generated and identity columns", async () => {
    const { service, calls } = makeService({ catalogue: guardedCatalogue })

    for (const [columnName, key] of [
      ["computed", "generated"],
      ["serial_no", "identity"],
    ] as const) {
      const error = await rejection(
        service.dropColumnDefault({
          idempotencyKey: `dd-${key}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "notes",
          column: columnName,
        }),
      )
      expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    }
    expect(calls).toHaveLength(0)
  })
})

describe("replay reconstructs the compiled statement from the recorded command", () => {
  function seededOperationRecord(
    key: string,
    commandType: string,
    command: Record<string, unknown>,
  ) {
    return {
      id: "1",
      idempotency_key: key,
      command_type: commandType,
      command,
      checksum: "c".repeat(64),
      status: "succeeded",
      actor_fingerprint: "f".repeat(64),
      error_code: null,
      result: null,
      created_at: new Date("2026-09-25T00:00:00.000Z"),
      finished_at: new Date("2026-09-25T00:00:01.000Z"),
    }
  }

  function recordPool(
    records: Readonly<Record<string, Record<string, unknown>>>,
  ): Pool {
    return {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("FROM microjbase.schema_operations")) {
          const key = values?.[0]
          const row = typeof key === "string" ? records[key] : undefined
          return { rows: row === undefined ? [] : [row] } as never
        }
        throw new Error(`unexpected preflight query: ${text}`)
      },
    } as unknown as Pool
  }

  it("changeColumnType replays from the recorded fromType, not the live destination type", async () => {
    const key = "type-replay-key"
    const { service, calls } = makeService({
      // The catalogue already shows the destination type: a retry that
      // re-derived fromType from the live catalogue could not compile.
      catalogue: catalogue([
        table("notes", {
          columns: [
            column("id", { isNullable: false, renderedType: "uuid" }),
            column("priority", { isNullable: false, renderedType: "bigint" }),
          ],
        }),
      ]),
      pool: recordPool({
        [key]: seededOperationRecord(key, "schema.column.type.change", {
          schema: APP_SCHEMA,
          table: "notes",
          column: "priority",
          fromType: "integer",
          toType: "bigint",
        }),
      }),
    })

    const outcome = await service.changeColumnType({
      idempotencyKey: key,
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "priority",
      toType: "bigint",
    })
    expect(outcome.replayed).toBe(false)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.options.command).toEqual({
      schema: APP_SCHEMA,
      table: "notes",
      column: "priority",
      fromType: "integer",
      toType: "bigint",
    })
    const statements = (call?.plan as { statements: readonly string[] })
      .statements
    expect(statements[1]).toBe(
      'ALTER TABLE "app"."notes" ALTER COLUMN "priority" TYPE bigint',
    )
  })

  it("setColumnDefault replays from the recorded type, not the live type", async () => {
    const key = "default-replay-key"
    const { service, calls } = makeService({
      // The column was converted date -> timestamp after the recorded
      // success; the retry must still render the original date literal.
      catalogue: catalogue([
        table("notes", {
          columns: [
            column("id", { isNullable: false, renderedType: "uuid" }),
            column("due_on", {
              renderedType: "timestamp without time zone",
            }),
          ],
        }),
      ]),
      pool: recordPool({
        [key]: seededOperationRecord(key, "schema.column.default.set", {
          schema: APP_SCHEMA,
          table: "notes",
          column: "due_on",
          default: { kind: "literal", value: "2026-01-01" },
          type: "date",
        }),
      }),
    })

    await service.setColumnDefault({
      idempotencyKey: key,
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "due_on",
      default: { kind: "literal", value: "2026-01-01" },
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.options.command).toEqual({
      schema: APP_SCHEMA,
      table: "notes",
      column: "due_on",
      default: { kind: "literal", value: "2026-01-01" },
      type: "date",
    })
    expect(
      (call?.plan as { statements: readonly string[] }).statements,
    ).toEqual([
      'ALTER TABLE "app"."notes" ALTER COLUMN "due_on" SET DEFAULT \'2026-01-01\'::date',
    ])
  })

  it("setColumnDefault replay never consults the catalogue", async () => {
    const key = "default-replay-missing-table"
    const { service, calls } = makeService({
      // The table is gone from the catalogue; a key with a recorded row must
      // still reach the executor instead of failing TABLE_NOT_FOUND.
      catalogue: catalogue([]),
      pool: recordPool({
        [key]: seededOperationRecord(key, "schema.column.default.set", {
          schema: APP_SCHEMA,
          table: "notes",
          column: "due_on",
          default: { kind: "literal", value: "2026-01-01" },
          type: "date",
        }),
      }),
    })

    await service.setColumnDefault({
      idempotencyKey: key,
      actor: "operator",
      schema: APP_SCHEMA,
      table: "notes",
      column: "due_on",
      default: { kind: "literal", value: "2026-01-01" },
    })
    expect(calls).toHaveLength(1)
  })

  it("fails closed when the recorded command lacks the compiled type", async () => {
    const key = "default-replay-malformed"
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
      pool: recordPool({
        [key]: seededOperationRecord(key, "schema.column.default.set", {
          schema: APP_SCHEMA,
          table: "notes",
          column: "title",
          default: { kind: "literal", value: "untitled" },
        }),
      }),
    })

    const error = await rejection(
      service.setColumnDefault({
        idempotencyKey: key,
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "title",
        default: { kind: "literal", value: "untitled" },
      }),
    )
    expect(error).toMatchObject({ code: "INTERNAL_ERROR", status: 500 })
    expect(calls).toHaveLength(0)
  })
})

describe("dry-run always runs the preflight guards", () => {
  const dropRecord = (key: string) => ({
    id: "1",
    idempotency_key: key,
    command_type: "schema.table.drop",
    command: { schema: APP_SCHEMA, table: "notes", confirmed: true },
    checksum: "c".repeat(64),
    status: "succeeded",
    actor_fingerprint: "f".repeat(64),
    error_code: null,
    result: null,
    created_at: new Date("2026-09-25T00:00:00.000Z"),
    finished_at: new Date("2026-09-25T00:00:01.000Z"),
  })

  function keyPool(key: string): Pool {
    return {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("FROM microjbase.schema_operations")) {
          return {
            rows: values?.[0] === key ? [dropRecord(key)] : [],
          } as never
        }
        throw new Error(`unexpected preflight query: ${text}`)
      },
    } as unknown as Pool
  }

  it("dropTable refuses an exposed table with a wrong confirmation on a reused dry-run key", async () => {
    const key = "dry-drop-exposed"
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
      registry: exposedRegistry(APP_SCHEMA, "notes"),
      pool: keyPool(key),
    })

    const error = await rejection(
      service.dropTable({
        idempotencyKey: key,
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        confirm: "nope",
        dryRun: true,
      }),
    )
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })

  it("dropTable refuses a wrong confirmation on a reused dry-run key", async () => {
    const key = "dry-drop-confirm"
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
      pool: keyPool(key),
    })

    const error = await rejection(
      service.dropTable({
        idempotencyKey: key,
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        confirm: "nope",
        dryRun: true,
      }),
    )
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })

  it("dropColumn refuses an exposed table with a wrong confirmation on a reused dry-run key", async () => {
    const key = "dry-dropcolumn-exposed"
    const { service, calls } = makeService({
      catalogue: catalogue([table("notes")]),
      registry: exposedRegistry(APP_SCHEMA, "notes"),
      pool: keyPool(key),
    })

    const error = await rejection(
      service.dropColumn({
        idempotencyKey: key,
        actor: "operator",
        schema: APP_SCHEMA,
        table: "notes",
        column: "title",
        confirm: "nope",
        dryRun: true,
      }),
    )
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(calls).toHaveLength(0)
  })
})
