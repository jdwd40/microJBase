import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { AppError } from "../../../src/core/index.js"
import {
  SCHEMA_CATALOGUE_COLUMNS_SQL,
  SCHEMA_CATALOGUE_SCHEMAS_SQL,
  SCHEMA_CATALOGUE_TABLES_SQL,
  createSchemaCatalogueReader,
  mapSchemaCatalogue,
  readSchemaCatalogue,
  type SchemaCatalogueColumnRow,
  type SchemaCatalogueDependencies,
  type SchemaCatalogueSchemaRow,
  type SchemaCatalogueTableRow,
} from "../../../src/database/schema-catalogue.js"

function pgResult(rows: unknown[]): pg.QueryResult {
  return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] }
}

function createMockQuery(data: {
  schemas?: unknown[]
  tables?: unknown[]
  columns?: unknown[]
}): SchemaCatalogueDependencies["query"] {
  return (async (text: string) => {
    if (text === SCHEMA_CATALOGUE_SCHEMAS_SQL) {
      return pgResult(data.schemas ?? [])
    }
    if (text === SCHEMA_CATALOGUE_TABLES_SQL) {
      return pgResult(data.tables ?? [])
    }
    if (text === SCHEMA_CATALOGUE_COLUMNS_SQL) {
      return pgResult(data.columns ?? [])
    }
    throw new Error(`Unexpected SQL: ${text}`)
  }) as SchemaCatalogueDependencies["query"]
}

function schemaRow(
  overrides: Record<string, unknown> = {},
): SchemaCatalogueSchemaRow {
  return { schema_name: "app", owner: "owner_role", ...overrides }
}

function tableRow(
  overrides: Record<string, unknown> = {},
): SchemaCatalogueTableRow {
  return {
    schema_name: "app",
    table_name: "items",
    owner: "owner_role",
    kind: "regular",
    has_row_security: false,
    has_forced_row_security: false,
    ...overrides,
  }
}

function columnRow(
  overrides: Record<string, unknown> = {},
): SchemaCatalogueColumnRow {
  return {
    schema_name: "app",
    table_name: "items",
    ordinal: 1,
    name: "id",
    is_nullable: false,
    default_expression: null,
    generated: "",
    identity: "",
    rendered_type: "uuid",
    type_schema: "pg_catalog",
    type_name: "uuid",
    type_kind: "b",
    base_type_schema: null,
    base_type_name: null,
    base_type_kind: null,
    ...overrides,
  }
}

const FORBIDDEN_TOKENS =
  /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|MERGE|CALL)\b/i

describe("schema catalogue query shape", () => {
  it("executes only fixed read-only SELECT statements with no parameters", async () => {
    const calls: { text: string; values: unknown }[] = []
    const query = (async (text: string, values?: unknown[]) => {
      calls.push({ text, values })
      return pgResult([])
    }) as SchemaCatalogueDependencies["query"]

    await readSchemaCatalogue(query)

    expect(calls.map((call) => call.text)).toEqual([
      SCHEMA_CATALOGUE_SCHEMAS_SQL,
      SCHEMA_CATALOGUE_TABLES_SQL,
      SCHEMA_CATALOGUE_COLUMNS_SQL,
    ])
    for (const call of calls) {
      expect(call.values).toBeUndefined()
      expect(call.text.trimStart().toUpperCase().startsWith("SELECT")).toBe(
        true,
      )
      expect(call.text).not.toContain("${")
      expect(call.text).not.toContain(";")
      expect(call.text).not.toMatch(FORBIDDEN_TOKENS)
    }
  })

  it("reader port reads through the injected query only", async () => {
    const query = vi.fn(createMockQuery({ schemas: [schemaRow()] }))
    const typedQuery = query as unknown as SchemaCatalogueDependencies["query"]
    const reader = createSchemaCatalogueReader({ query: typedQuery })

    const catalogue = await reader.read()

    expect(query).toHaveBeenCalledTimes(3)
    expect(catalogue.schemas.map((schema) => schema.name)).toEqual(["app"])
  })
})

describe("schema catalogue row mapping", () => {
  it("maps an empty schema with no tables", () => {
    const catalogue = mapSchemaCatalogue([schemaRow()], [], [])

    expect(catalogue.schemas).toHaveLength(1)
    expect(catalogue.schemas[0]).toEqual({
      name: "app",
      owner: "owner_role",
      tables: [],
    })
  })

  it("maps a regular table with nullable, defaulted, identity, and generated columns", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [tableRow()],
      [
        columnRow({
          ordinal: 1,
          name: "id",
          default_expression: "gen_random_uuid()",
        }),
        columnRow({
          ordinal: 2,
          name: "title",
          is_nullable: true,
          rendered_type: "text",
          type_name: "text",
        }),
        columnRow({
          ordinal: 3,
          name: "seq",
          is_nullable: false,
          identity: "a",
          rendered_type: "integer",
          type_name: "int4",
        }),
        columnRow({
          ordinal: 4,
          name: "computed",
          is_nullable: true,
          default_expression: "length(title)",
          generated: "s",
          rendered_type: "integer",
          type_name: "int4",
        }),
      ],
    )

    const table = catalogue.schemas[0]?.tables[0]
    expect(table).toMatchObject({
      schema: "app",
      name: "items",
      owner: "owner_role",
      kind: "regular",
      hasRowSecurity: false,
      hasForcedRowSecurity: false,
    })
    expect(table?.columns).toEqual([
      {
        ordinal: 1,
        name: "id",
        isNullable: false,
        defaultExpression: "gen_random_uuid()",
        generated: "none",
        identity: "none",
        renderedType: "uuid",
        type: { schema: "pg_catalog", name: "uuid", kind: "base" },
        baseType: null,
      },
      {
        ordinal: 2,
        name: "title",
        isNullable: true,
        defaultExpression: null,
        generated: "none",
        identity: "none",
        renderedType: "text",
        type: { schema: "pg_catalog", name: "text", kind: "base" },
        baseType: null,
      },
      {
        ordinal: 3,
        name: "seq",
        isNullable: false,
        defaultExpression: null,
        generated: "none",
        identity: "always",
        renderedType: "integer",
        type: { schema: "pg_catalog", name: "int4", kind: "base" },
        baseType: null,
      },
      {
        ordinal: 4,
        name: "computed",
        isNullable: true,
        defaultExpression: null,
        generated: "stored",
        identity: "none",
        renderedType: "integer",
        type: { schema: "pg_catalog", name: "int4", kind: "base" },
        baseType: null,
      },
    ])
  })

  it("maps partitioned tables and identity by_default state", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [
        tableRow({
          table_name: "events",
          kind: "partitioned",
          has_row_security: true,
          has_forced_row_security: true,
        }),
      ],
      [
        columnRow({
          table_name: "events",
          ordinal: 1,
          name: "occurred_at",
          is_nullable: false,
          rendered_type: "timestamp with time zone",
          type_name: "timestamptz",
        }),
        columnRow({
          table_name: "events",
          ordinal: 2,
          name: "seq",
          is_nullable: false,
          identity: "d",
          rendered_type: "integer",
          type_name: "int4",
        }),
      ],
    )

    const table = catalogue.schemas[0]?.tables[0]
    expect(table?.kind).toBe("partitioned")
    expect(table?.hasRowSecurity).toBe(true)
    expect(table?.hasForcedRowSecurity).toBe(true)
    expect(table?.columns[1]?.identity).toBe("by_default")
  })

  it("preserves declared domain identity alongside the underlying base type", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [tableRow()],
      [
        columnRow({
          ordinal: 1,
          name: "postal",
          is_nullable: true,
          default_expression: "('12345'::text)::app.postal_code",
          rendered_type: "app.postal_code",
          type_schema: "app",
          type_name: "postal_code",
          type_kind: "d",
          base_type_schema: "pg_catalog",
          base_type_name: "text",
          base_type_kind: "b",
        }),
        columnRow({
          ordinal: 2,
          name: "status",
          is_nullable: true,
          rendered_type: "app.order_status",
          type_schema: "app",
          type_name: "order_status",
          type_kind: "e",
        }),
      ],
    )

    const columns = catalogue.schemas[0]?.tables[0]?.columns
    expect(columns?.[0]).toMatchObject({
      name: "postal",
      defaultExpression: "('12345'::text)::app.postal_code",
      renderedType: "app.postal_code",
      type: { schema: "app", name: "postal_code", kind: "domain" },
      baseType: { schema: "pg_catalog", name: "text", kind: "base" },
    })
    expect(columns?.[1]?.type).toEqual({
      schema: "app",
      name: "order_status",
      kind: "enum",
    })
    expect(columns?.[1]?.baseType).toBeNull()
  })

  it("groups and orders deterministically regardless of input row order", () => {
    const schemas = [
      schemaRow({ schema_name: "zeta" }),
      schemaRow({ schema_name: "app" }),
    ]
    const tables = [
      tableRow({ table_name: "zebra" }),
      tableRow({ table_name: "items" }),
      tableRow({ schema_name: "zeta", table_name: "only" }),
    ]
    const columns = [
      columnRow({ table_name: "zebra", ordinal: 2, name: "b" }),
      columnRow({ table_name: "zebra", ordinal: 1, name: "a" }),
      columnRow({ table_name: "items", ordinal: 2, name: "y" }),
      columnRow({ table_name: "items", ordinal: 1, name: "x" }),
      columnRow({
        schema_name: "zeta",
        table_name: "only",
        ordinal: 1,
        name: "z",
      }),
    ]

    const shuffled = mapSchemaCatalogue(
      [...schemas].reverse(),
      [...tables].reverse(),
      [...columns].reverse(),
    )
    const ordered = mapSchemaCatalogue(schemas, tables, columns)

    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(ordered))
    expect(shuffled.schemas.map((schema) => schema.name)).toEqual([
      "app",
      "zeta",
    ])
    expect(shuffled.schemas[0]?.tables.map((table) => table.name)).toEqual([
      "items",
      "zebra",
    ])
    expect(
      shuffled.schemas[0]?.tables[0]?.columns.map((column) => column.name),
    ).toEqual(["x", "y"])
  })

  it("fails explicitly on malformed or impossible rows", () => {
    expect(() =>
      mapSchemaCatalogue([{ schema_name: 42 } as never], [], []),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    expect(() =>
      mapSchemaCatalogue([schemaRow({ owner: "" })], [], []),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    expect(() =>
      mapSchemaCatalogue([schemaRow()], [tableRow({ kind: "view" })], []),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow({ ordinal: 0 })],
      ),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    const badColumns: Record<string, unknown>[] = [
      { is_nullable: "yes" },
      { identity: "x" },
      { generated: "x" },
      { type_kind: "x" },
      { base_type_name: "text", base_type_schema: null },
    ]
    for (const overrides of badColumns) {
      expect(() =>
        mapSchemaCatalogue([schemaRow()], [tableRow()], [columnRow(overrides)]),
      ).toThrowError(
        expect.objectContaining({
          code: "INTERNAL_ERROR",
          message: expect.stringContaining("Malformed schema catalogue row"),
        }),
      )
    }
  })
})

describe("schema catalogue dependency errors", () => {
  it("translates connection failures through the database error boundary", async () => {
    const error = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      { code: "ECONNREFUSED" },
    )
    const query = (async () => {
      throw error
    }) as SchemaCatalogueDependencies["query"]

    await expect(readSchemaCatalogue(query)).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: "Database is unavailable",
    })
  })

  it("wraps unexpected dependency errors as INTERNAL_ERROR", async () => {
    const query = (async () => {
      throw new Error("boom")
    }) as SchemaCatalogueDependencies["query"]

    await expect(readSchemaCatalogue(query)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "An unexpected database error occurred",
    })
  })

  it("passes existing AppError instances through unchanged", async () => {
    const appError = new AppError(
      "DATABASE_UNAVAILABLE",
      "Database is unavailable",
      503,
    )
    const query = (async () => {
      throw appError
    }) as SchemaCatalogueDependencies["query"]

    await expect(readSchemaCatalogue(query)).rejects.toBe(appError)
  })
})
