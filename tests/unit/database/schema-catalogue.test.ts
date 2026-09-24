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
    constraint_type: null,
    constraint_columns: null,
    ref_schema: null,
    ref_table: null,
    ref_columns: null,
    on_update: null,
    on_delete: null,
    is_unique: null,
    is_expression: null,
    has_predicate: null,
    index_columns: null,
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

function constraintRow(
  overrides: Record<string, unknown> = {},
): SchemaCatalogueRow {
  return {
    ...baseRow(),
    row_kind: "constraint",
    schema_name: "app",
    table_name: "items",
    name: "items_pkey",
    constraint_type: "p",
    constraint_columns: ["id"],
    ...overrides,
  }
}

function foreignKeyRow(
  overrides: Record<string, unknown> = {},
): SchemaCatalogueRow {
  return constraintRow({
    name: "items_owner_id_fkey",
    constraint_type: "f",
    constraint_columns: ["owner_id"],
    ref_schema: "app",
    ref_table: "owners",
    ref_columns: ["id"],
    on_update: "a",
    on_delete: "c",
    ...overrides,
  })
}

function indexRow(overrides: Record<string, unknown> = {}): SchemaCatalogueRow {
  return {
    ...baseRow(),
    row_kind: "index",
    schema_name: "app",
    table_name: "items",
    name: "items_title_idx",
    is_unique: false,
    is_expression: false,
    has_predicate: false,
    index_columns: ["title"],
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
    // The statement is a single WITH ... SELECT (the pin CTE leads the
    // statement); it must remain one parameterless read-only statement.
    expect(calls[0]?.text.trimStart().toUpperCase().startsWith("WITH")).toBe(
      true,
    )
    expect(calls[0]?.text).not.toContain("${")
    expect(calls[0]?.text).not.toContain(";")
    expect(calls[0]?.text).not.toMatch(FORBIDDEN_TOKENS)
  })

  it("pins transaction-local search_path to pg_catalog behind a LATERAL barrier", () => {
    expect(SCHEMA_CATALOGUE_SQL).toContain(
      "pg_catalog.set_config('search_path', 'pg_catalog', true)",
    )
    expect(SCHEMA_CATALOGUE_SQL).toContain("pg_catalog.format_type(")
    expect(SCHEMA_CATALOGUE_SQL).toContain("pg_catalog.pg_get_expr(")
    expect(SCHEMA_CATALOGUE_SQL).toContain("pg_catalog.pg_get_userbyid(")
    // The pin is a semantic evaluation barrier, not planner luck: a
    // MATERIALIZED CTE runs set_config once before the outer query, and the
    // catalogue UNION renders inside a LATERAL subquery that carries an
    // outer reference into every branch, so rendering cannot run ahead of
    // the pin on any planner path.
    expect(SCHEMA_CATALOGUE_SQL).toContain("search_path_pin AS MATERIALIZED")
    expect(SCHEMA_CATALOGUE_SQL).toContain("CROSS JOIN LATERAL")
    // One outer-reference carrier per UNION branch: schema, table, column,
    // constraint, and index.
    expect(SCHEMA_CATALOGUE_SQL.match(/pin\.pinned_path/g)).toHaveLength(5)
  })

  it("returns schema, table, column, constraint, and index row sets together", () => {
    expect(SCHEMA_CATALOGUE_SQL).toContain("'schema' AS row_kind")
    expect(SCHEMA_CATALOGUE_SQL).toContain("'constraint'")
    expect(SCHEMA_CATALOGUE_SQL).toContain("'index'")
    expect(SCHEMA_CATALOGUE_SQL).toContain("UNION ALL")
    expect(SCHEMA_CATALOGUE_SQL.match(/UNION ALL/g)).toHaveLength(4)
    // Constraint rows come from pg_constraint; index rows from pg_index with
    // constraint-backed indexes (pk/unique/exclusion) excluded so a backing
    // index is never double-reported alongside its constraint.
    expect(SCHEMA_CATALOGUE_SQL).toContain("pg_catalog.pg_constraint con")
    expect(SCHEMA_CATALOGUE_SQL).toContain("pg_catalog.pg_index i")
    expect(SCHEMA_CATALOGUE_SQL).toContain("con.conindid = i.indexrelid")
    expect(SCHEMA_CATALOGUE_SQL).toContain("AND con.oid IS NULL")
    // Deterministic ordering: name breaks ties between rows of one kind on
    // the same table (constraint and index rows have no ordinal).
    expect(SCHEMA_CATALOGUE_SQL).toContain(
      "ORDER BY r.row_kind, r.schema_name, r.table_name, r.ordinal, r.name",
    )
    // NOT NULL constraint entries (PostgreSQL 18 contype 'n') are excluded;
    // nullability is reported per column instead.
    expect(SCHEMA_CATALOGUE_SQL).toContain(
      "con.contype IN ('p', 'u', 'f', 'c', 'x')",
    )
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
        constraints: [],
        indexes: [],
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

describe("schema catalogue constraint and index mapping", () => {
  it("maps primary-key, unique, and check constraints with ordered columns", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [tableRow()],
      [columnRow()],
      [
        constraintRow({ name: "items_pkey", constraint_type: "p" }),
        constraintRow({
          name: "items_title_key",
          constraint_type: "u",
          constraint_columns: ["title"],
        }),
        constraintRow({
          name: "items_title_check",
          constraint_type: "c",
          constraint_columns: null,
        }),
      ],
      [],
    )

    // Constraints are sorted by name regardless of input order.
    expect(catalogue.schemas[0]?.tables[0]?.constraints).toEqual([
      {
        name: "items_pkey",
        classification: "primary_key",
        columns: ["id"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
      {
        name: "items_title_check",
        classification: "check",
        columns: [],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
      {
        name: "items_title_key",
        classification: "unique",
        columns: ["title"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
    ])
  })

  it("maps foreign keys with referenced target and update/delete actions", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [tableRow()],
      [columnRow()],
      [
        foreignKeyRow(),
        foreignKeyRow({
          name: "items_alt_fkey",
          constraint_columns: ["alt_id"],
          ref_schema: "other",
          ref_table: "things",
          ref_columns: ["thing_id"],
          on_update: "r",
          on_delete: "n",
        }),
        foreignKeyRow({
          name: "items_legacy_fkey",
          constraint_columns: ["legacy_id"],
          on_update: "d",
          on_delete: "a",
        }),
      ],
      [],
    )

    const constraints = catalogue.schemas[0]?.tables[0]?.constraints
    expect(constraints).toEqual([
      {
        name: "items_alt_fkey",
        classification: "foreign_key",
        columns: ["alt_id"],
        references: {
          schema: "other",
          table: "things",
          columns: ["thing_id"],
        },
        onUpdate: "restrict",
        onDelete: "set_null",
      },
      {
        name: "items_legacy_fkey",
        classification: "foreign_key",
        columns: ["legacy_id"],
        references: {
          schema: "app",
          table: "owners",
          columns: ["id"],
        },
        // set_default is reported as observed data even though the v0.2
        // management allowlist excludes it.
        onUpdate: "set_default",
        onDelete: "no_action",
      },
      {
        name: "items_owner_id_fkey",
        classification: "foreign_key",
        columns: ["owner_id"],
        references: { schema: "app", table: "owners", columns: ["id"] },
        onUpdate: "no_action",
        onDelete: "cascade",
      },
    ])
  })

  it("maps composite ordered constraint columns", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [tableRow()],
      [columnRow()],
      [
        constraintRow({
          name: "items_pair_key",
          constraint_type: "u",
          constraint_columns: ["zeta", "alpha"],
        }),
      ],
      [],
    )

    const constraint = catalogue.schemas[0]?.tables[0]?.constraints[0]
    expect(constraint?.classification).toBe("unique")
    // pg_constraint.conkey order is preserved verbatim.
    expect(constraint?.columns).toEqual(["zeta", "alpha"])
  })

  it("maps ordinary, unique, partial, and expression indexes", () => {
    const catalogue = mapSchemaCatalogue(
      [schemaRow()],
      [tableRow()],
      [columnRow()],
      [],
      [
        indexRow({ name: "zulu_idx" }),
        indexRow({
          name: "alpha_unique_idx",
          is_unique: true,
          index_columns: ["title", "id"],
        }),
        indexRow({
          name: "partial_idx",
          has_predicate: true,
          index_columns: ["owner_id"],
        }),
        indexRow({
          name: "expression_idx",
          is_expression: true,
          index_columns: [null],
        }),
        indexRow({
          name: "partial_expression_idx",
          is_expression: true,
          has_predicate: true,
          index_columns: [null],
        }),
      ],
    )

    // Sorted by name; classification precedence: expression over partial.
    expect(catalogue.schemas[0]?.tables[0]?.indexes).toEqual([
      {
        name: "alpha_unique_idx",
        classification: "index",
        isUnique: true,
        isExpression: false,
        hasPredicate: false,
        columns: ["title", "id"],
      },
      {
        name: "expression_idx",
        classification: "expression_index",
        isUnique: false,
        isExpression: true,
        hasPredicate: false,
        columns: [null],
      },
      {
        name: "partial_expression_idx",
        classification: "expression_index",
        isUnique: false,
        isExpression: true,
        hasPredicate: true,
        columns: [null],
      },
      {
        name: "partial_idx",
        classification: "partial_index",
        isUnique: false,
        isExpression: false,
        hasPredicate: true,
        columns: ["owner_id"],
      },
      {
        name: "zulu_idx",
        classification: "index",
        isUnique: false,
        isExpression: false,
        hasPredicate: false,
        columns: ["title"],
      },
    ])
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

  it("fails on malformed constraint rows of every classification", () => {
    const badConstraintRows: Record<string, unknown>[] = [
      { constraint_type: "n" },
      { constraint_type: "z" },
      { constraint_columns: [] },
      { constraint_columns: ["id", 7] },
      { constraint_columns: null },
      { on_update: "x" },
      { on_delete: "x" },
      { ref_schema: null },
      { ref_columns: [] },
      { ref_schema: "app", on_update: null },
    ]
    for (const overrides of badConstraintRows) {
      expect(() =>
        mapSchemaCatalogue(
          [schemaRow()],
          [tableRow()],
          [columnRow()],
          [foreignKeyRow(overrides)],
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "INTERNAL_ERROR",
          message: expect.stringContaining("Malformed schema catalogue row"),
        }),
      )
    }

    // Non-foreign-key constraints must never carry a referenced target or
    // actions.
    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [constraintRow({ ref_schema: "app" })],
      ),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    // A check constraint must never carry a column list (the SQL statement
    // normalizes pg_constraint.conkey to NULL for checks because PostgreSQL
    // 18 populates it while PostgreSQL 16 leaves it NULL).
    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [constraintRow({ constraint_type: "c", constraint_columns: ["id"] })],
      ),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))
  })

  it("fails on malformed index rows", () => {
    const badIndexRows: Record<string, unknown>[] = [
      { is_unique: null },
      { is_expression: "yes" },
      { has_predicate: 1 },
      { index_columns: null },
      { index_columns: [] },
      { index_columns: ["id", ""] },
      { index_columns: [7] },
      // A null column position is only meaningful for an expression index.
      { index_columns: [null] },
    ]
    for (const overrides of badIndexRows) {
      expect(() =>
        mapSchemaCatalogue(
          [schemaRow()],
          [tableRow()],
          [columnRow()],
          [],
          [indexRow(overrides)],
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "INTERNAL_ERROR",
          message: expect.stringContaining("Malformed schema catalogue row"),
        }),
      )
    }
  })

  it("fails when constraint or index rows carry another kind's fields", () => {
    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [foreignKeyRow({ is_nullable: true })],
      ),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [foreignKeyRow({ ordinal: 1 })],
      ),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [],
        [indexRow({ constraint_type: "u" })],
      ),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [],
        [indexRow({ has_row_security: false })],
      ),
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_ERROR" }))
  })

  it("fails on duplicate constraint names, duplicate index names, and orphan rows", () => {
    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [constraintRow(), constraintRow()],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining('duplicate constraint "items_pkey"'),
      }),
    )

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [],
        [indexRow(), indexRow()],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining('duplicate index "items_title_idx"'),
      }),
    )

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [constraintRow({ table_name: "missing" })],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("has no matching table row"),
      }),
    )

    expect(() =>
      mapSchemaCatalogue(
        [schemaRow()],
        [tableRow()],
        [columnRow()],
        [],
        [indexRow({ table_name: "missing" })],
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("has no matching table row"),
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
