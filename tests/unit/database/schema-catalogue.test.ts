import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { AppError } from "../../../src/core/index.js"
import {
  SCHEMA_CATALOGUE_SQL,
  createSchemaCatalogueReader,
  mapSchemaCatalogue,
  readSchemaCatalogue,
  type SchemaCatalogueDependencies,
  type SchemaCatalogueRow,
} from "../../../src/database/schema-catalogue.js"

function pgResult(rows: unknown[]): pg.QueryResult {
  return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] }
}

function createMockQuery(
  rows: unknown[],
): SchemaCatalogueDependencies["query"] {
  return (async (text: string) => {
    if (text !== SCHEMA_CATALOGUE_SQL) {
      throw new Error(`Unexpected SQL: ${text}`)
    }
    return pgResult(rows)
  }) as SchemaCatalogueDependencies["query"]
}

function baseRow(): SchemaCatalogueRow {
  return {
    row_kind: "schema",
    schema_name: "app",
    table_name: null,
    ordinal: null,
    name: null,
    owner: null,
    kind: null,
    has_row_security: null,
    has_forced_row_security: null,
    is_nullable: null,
    default_expression: null,
    generated: null,
    identity: null,
    rendered_type: null,
    type_schema: null,
    type_name: null,
    type_kind: null,
    base_type_schema: null,
    base_type_name: null,
    base_type_kind: null,
  }
}

function schemaRow(
  overrides: Record<string, unknown> = {},
): SchemaCatalogueRow {
  return {
    ...baseRow(),
    row_kind: "schema",
    schema_name: "app",
    owner: "owner_role",
    ...overrides,
  }
}

function tableRow(overrides: Record<string, unknown> = {}): SchemaCatalogueRow {
  return {
    ...baseRow(),
    row_kind: "table",
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
): SchemaCatalogueRow {
  return {
    ...baseRow(),
    row_kind: "column",
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
    ...overrides,
  }
}

const FORBIDDEN_TOKENS =
  /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|MERGE|CALL)\b/i

describe("schema catalogue query shape", () => {
  it("executes exactly one fixed read-only SELECT statement with no parameters", async () => {
    const calls: { text: string; values: unknown }[] = []
    const query = (async (text: string, values?: unknown[]) => {
      calls.push({ text, values })
      return pgResult([])
    }) as SchemaCatalogueDependencies["query"]

    await readSchemaCatalogue(query)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe(SCHEMA_CATALOGUE_SQL)
    expect(calls[0]?.values).toBeUndefined()
    expect(calls[0]?.text.trimStart().toUpperCase().startsWith("SELECT")).toBe(
      true,
    )
    expect(calls[0]?.text).not.toContain("${")
    expect(calls[0]?.text).not.toContain(";")
    expect(calls[0]?.text).not.toMatch(FORBIDDEN_TOKENS)
  })

  it("pins transaction-local search_path to pg_catalog inside the statement", () => {
    expect(SCHEMA_CATALOGUE_SQL).toContain(
      "pg_catalog.set_config('search_path', 'pg_catalog', true)",
    )
    expect(SCHEMA_CATALOGUE_SQL).toContain("pg_catalog.format_type(")
    expect(SCHEMA_CATALOGUE_SQL).toContain("pg_catalog.pg_get_expr(")
    expect(SCHEMA_CATALOGUE_SQL).toContain("pg_catalog.pg_get_userbyid(")
  })

  it("returns schema, table, and column row sets together", () => {
    expect(SCHEMA_CATALOGUE_SQL).toContain("'schema' AS row_kind")
    expect(SCHEMA_CATALOGUE_SQL).toContain("UNION ALL")
    expect(SCHEMA_CATALOGUE_SQL.match(/UNION ALL/g)).toHaveLength(2)
  })

  it("reader port issues exactly one query per read", async () => {
    const query = vi.fn(createMockQuery([schemaRow()]))
    const typedQuery = query as unknown as SchemaCatalogueDependencies["query"]
    const reader = createSchemaCatalogueReader({ query: typedQuery })

    const catalogue = await reader.read()

    expect(query).toHaveBeenCalledTimes(1)
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

  it("maps a zero-column table with an empty column list", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [tableRow({ table_name: "empty_table" })],
      [],
    )

    expect(catalogue.schemas[0]?.tables).toEqual([
      {
        schema: "app",
        name: "empty_table",
        owner: "owner_role",
        kind: "regular",
        hasRowSecurity: false,
        hasForcedRowSecurity: false,
        columns: [],
      },
    ])
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
        columnRow({
          ordinal: 5,
          name: "computed_virtual",
          is_nullable: true,
          default_expression: "length(title)",
          generated: "v",
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
      {
        ordinal: 5,
        name: "computed_virtual",
        isNullable: true,
        defaultExpression: null,
        generated: "virtual",
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

  it("preserves declared domain identity alongside the immediate base type", () => {
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

  it("reports an immediate base type that is itself a domain without recursing", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [tableRow()],
      [
        columnRow({
          ordinal: 1,
          name: "nested",
          is_nullable: true,
          rendered_type: "app.child_domain",
          type_schema: "app",
          type_name: "child_domain",
          type_kind: "d",
          base_type_schema: "app",
          base_type_name: "parent_domain",
          base_type_kind: "d",
        }),
      ],
    )

    const column = catalogue.schemas[0]?.tables[0]?.columns[0]
    expect(column?.type).toEqual({
      schema: "app",
      name: "child_domain",
      kind: "domain",
    })
    expect(column?.baseType).toEqual({
      schema: "app",
      name: "parent_domain",
      kind: "domain",
    })
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
})

describe("schema catalogue strict validation", () => {
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

  it("fails when a row carries a field owned by another row kind", () => {
    expect(() =>
      mapSchemaCatalogue([schemaRow({ table_name: "items" })], [], []),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    expect(() =>
      mapSchemaCatalogue([schemaRow()], [tableRow({ is_nullable: true })], []),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow({ has_row_security: false })],
      ),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))
  })

  it("fails on duplicate schema names, table keys, and column ordinals/names", () => {
    expect(() =>
      mapSchemaCatalogue([schemaRow(), schemaRow()], [], []),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining('duplicate schema "app"'),
      }),
    )

    expect(() =>
      mapSchemaCatalogue([schemaRow()], [tableRow(), tableRow()], []),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining('duplicate table "app.items"'),
      }),
    )

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [
          columnRow({ ordinal: 1, name: "a" }),
          columnRow({ ordinal: 1, name: "b" }),
        ],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("duplicate ordinal 1"),
      }),
    )

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [
          columnRow({ ordinal: 1, name: "a" }),
          columnRow({ ordinal: 2, name: "a" }),
        ],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining('duplicate column "a"'),
      }),
    )
  })

  it("fails on orphan tables and columns instead of dropping them", () => {
    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow({ schema_name: "missing" })],
        [],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("has no matching schema row"),
      }),
    )

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow({ table_name: "missing" })],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("has no matching table row"),
      }),
    )
  })

  it("enforces the domain iff immediate base type invariant", () => {
    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow({ type_kind: "d", base_type_name: null })],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("missing its immediate base type"),
      }),
    )

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [
          columnRow({
            type_kind: "b",
            base_type_schema: "pg_catalog",
            base_type_name: "text",
            base_type_kind: "b",
          }),
        ],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("non-domain"),
      }),
    )
  })
})

describe("schema catalogue dependency errors", () => {
  it("translates connection failures through the database error boundary", async () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 127.1:5432"), {
      code: "ECONNREFUSED",
    })
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
