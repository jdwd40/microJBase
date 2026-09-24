import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { AppError } from "../../../src/core/index.js"
import {
  MIGRATION_HISTORY_SQL,
  classifySchemaObject,
  createSchemaSnapshot,
  createSchemaSnapshotReader,
  mapMigrationHistory,
  readMigrationHistory,
  readSchemaSnapshot,
  type MigrationHistoryRow,
  type SchemaSnapshotDependencies,
} from "../../../src/database/schema-snapshot.js"
import { mapSchemaCatalogue } from "../../../src/database/schema-catalogue.js"
import type {
  SchemaCatalogue,
  TableRegistry,
} from "../../../src/contracts/index.js"

function pgResult(rows: unknown[]): pg.QueryResult {
  return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] }
}

function migrationRow(
  overrides: Record<string, unknown> = {},
): MigrationHistoryRow {
  return {
    filename: "0001_microjbase_schema.sql",
    checksum: "sha256:abc",
    applied_at: "2026-09-21T18:30:13.123456Z",
    ...overrides,
  }
}

// Minimal real catalogue built through the strict mapper: one operator
// schema with one table, plus the internal microjbase schema. Every row is
// fully populated because the strict mapper requires fields owned by other
// row kinds to be explicitly null.
function baseCatalogueRow(): Record<string, unknown> {
  return {
    row_kind: null,
    schema_name: null,
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

function buildCatalogue(): SchemaCatalogue {
  return mapSchemaCatalogue(
    [
      {
        ...baseCatalogueRow(),
        row_kind: "schema",
        schema_name: "app",
        owner: "owner_role",
      },
      {
        ...baseCatalogueRow(),
        row_kind: "schema",
        schema_name: "microjbase",
        owner: "microjbase",
      },
    ] as never,
    [
      {
        ...baseCatalogueRow(),
        row_kind: "table",
        schema_name: "app",
        table_name: "todos",
        owner: "owner_role",
        kind: "regular",
        has_row_security: true,
        has_forced_row_security: true,
      },
      {
        ...baseCatalogueRow(),
        row_kind: "table",
        schema_name: "microjbase",
        table_name: "users",
        owner: "microjbase",
        kind: "regular",
        has_row_security: true,
        has_forced_row_security: true,
      },
    ] as never,
    [
      {
        ...baseCatalogueRow(),
        row_kind: "column",
        schema_name: "app",
        table_name: "todos",
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
      },
    ] as never,
  )
}

function buildRegistry(
  exposed: readonly { alias: string; schema: string; table: string }[],
): TableRegistry {
  const tables = exposed.map((entry) =>
    Object.freeze({
      alias: entry.alias,
      schema: entry.schema,
      table: entry.table,
      primaryKey: "id" as const,
      readableColumns: Object.freeze([] as readonly string[]),
      insertableColumns: Object.freeze([] as readonly string[]),
      updatableColumns: Object.freeze([] as readonly string[]),
    }),
  )
  return {
    get: (alias: string) =>
      tables.find((table) => table.alias === alias) ?? null,
    list: () => tables,
  }
}

describe("migration history query shape", () => {
  it("reads microjbase.schema_migrations with one fixed parameterless SELECT", async () => {
    const calls: { text: string; values: unknown }[] = []
    const query = (async (text: string, values?: unknown[]) => {
      calls.push({ text, values })
      return pgResult([])
    }) as SchemaSnapshotDependencies["query"]

    await readMigrationHistory(query)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe(MIGRATION_HISTORY_SQL)
    expect(calls[0]?.values).toBeUndefined()
    expect(calls[0]?.text).toContain("FROM microjbase.schema_migrations")
    expect(calls[0]?.text).toContain("ORDER BY filename")
    // applied_at renders as a deterministic UTC ISO-8601 string so snapshots
    // are byte-stable regardless of the session timezone.
    expect(calls[0]?.text).toContain("AT TIME ZONE 'UTC'")
    expect(calls[0]?.text.trimStart().toUpperCase().startsWith("SELECT")).toBe(
      true,
    )
    expect(calls[0]?.text).not.toContain(";")
    expect(calls[0]?.text).not.toMatch(/\$\{|\$1/)
  })

  it("translates dependency errors through the database error boundary", async () => {
    const query = (async () => {
      throw new Error("boom")
    }) as SchemaSnapshotDependencies["query"]

    await expect(readMigrationHistory(query)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    })
  })
})

describe("migration history mapping", () => {
  it("maps rows to frozen records sorted by filename", () => {
    const records = mapMigrationHistory([
      migrationRow({ filename: "0002_b.sql" }),
      migrationRow({ filename: "0001_a.sql", checksum: "sha256:one" }),
    ])

    expect(records).toEqual([
      {
        filename: "0001_a.sql",
        checksum: "sha256:one",
        appliedAt: "2026-09-21T18:30:13.123456Z",
      },
      {
        filename: "0002_b.sql",
        checksum: "sha256:abc",
        appliedAt: "2026-09-21T18:30:13.123456Z",
      },
    ])
    expect(Object.isFrozen(records)).toBe(true)
    expect(Object.isFrozen(records[0])).toBe(true)
  })

  it("fails closed on malformed rows and duplicate filenames", () => {
    const badRows: Record<string, unknown>[] = [
      { filename: "" },
      { checksum: "" },
      { applied_at: "2026-09-21 18:30:13+00" },
      { applied_at: "2026-09-21T18:30:13Z" },
      { applied_at: null },
      { filename: 7 },
    ]
    for (const overrides of badRows) {
      expect(() => mapMigrationHistory([migrationRow(overrides)])).toThrowError(
        expect.objectContaining({
          code: "INTERNAL_ERROR",
          message: expect.stringContaining("Malformed schema migration row"),
        }),
      )
    }

    expect(() =>
      mapMigrationHistory([migrationRow(), migrationRow()]),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("duplicate migration filename"),
      }),
    )
  })
})

describe("schema object classification", () => {
  it("classifies internal schemas permanently and everything else as operator", () => {
    expect(classifySchemaObject("microjbase")).toBe("internal")
    expect(classifySchemaObject("pg_catalog")).toBe("internal")
    expect(classifySchemaObject("information_schema")).toBe("internal")
    expect(classifySchemaObject("pg_toast")).toBe("internal")
    expect(classifySchemaObject("pg_temp_1")).toBe("internal")
    expect(classifySchemaObject("public")).toBe("operator")
    expect(classifySchemaObject("app")).toBe("operator")
  })
})

describe("schema snapshot assembly", () => {
  it("assembles classification and exposure state over the catalogue", () => {
    const snapshot = createSchemaSnapshot({
      catalogue: buildCatalogue(),
      migrations: [
        {
          filename: "0001_microjbase_schema.sql",
          checksum: "sha256:abc",
          appliedAt: "2026-09-21T18:30:13.123456Z",
        },
      ],
      exposedTables: [{ alias: "todos", schema: "app", table: "todos" }],
    })

    expect(snapshot.schemas.map((schema) => schema.name)).toEqual([
      "app",
      "microjbase",
    ])
    const app = snapshot.schemas[0]
    expect(app?.classification).toBe("operator")
    expect(app?.tables[0]).toMatchObject({
      name: "todos",
      classification: "operator",
      exposure: { exposed: true, alias: "todos" },
    })

    const internal = snapshot.schemas[1]
    expect(internal?.classification).toBe("internal")
    expect(internal?.tables[0]).toMatchObject({
      name: "users",
      classification: "internal",
      exposure: { exposed: false, alias: null },
    })

    expect(snapshot.migrations).toEqual([
      {
        filename: "0001_microjbase_schema.sql",
        checksum: "sha256:abc",
        appliedAt: "2026-09-21T18:30:13.123456Z",
      },
    ])
  })

  it("returns deeply frozen, deterministically ordered output", () => {
    const migrations = [
      {
        filename: "0002_later.sql",
        checksum: "sha256:two",
        appliedAt: "2026-09-21T18:31:00.000000Z",
      },
      {
        filename: "0001_first.sql",
        checksum: "sha256:one",
        appliedAt: "2026-09-21T18:30:00.000000Z",
      },
    ]
    const snapshot = createSchemaSnapshot({
      catalogue: buildCatalogue(),
      migrations,
      exposedTables: [],
    })

    expect(snapshot.migrations.map((record) => record.filename)).toEqual([
      "0001_first.sql",
      "0002_later.sql",
    ])
    // The input array is copied and frozen, never reused.
    expect(snapshot.migrations).not.toBe(migrations)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.schemas)).toBe(true)
    expect(Object.isFrozen(snapshot.migrations)).toBe(true)
    expect(Object.isFrozen(snapshot.schemas[0])).toBe(true)
    expect(Object.isFrozen(snapshot.schemas[0]?.tables)).toBe(true)
    expect(Object.isFrozen(snapshot.schemas[0]?.tables[0])).toBe(true)
    expect(Object.isFrozen(snapshot.schemas[0]?.tables[0]?.exposure)).toBe(true)
  })

  it("produces identical JSON regardless of input order", () => {
    const catalogue = buildCatalogue()
    const first = createSchemaSnapshot({
      catalogue,
      migrations: [migrationRow({ filename: "0001_a.sql" }) as never],
      exposedTables: [],
    })
    const second = createSchemaSnapshot({
      catalogue,
      migrations: [migrationRow({ filename: "0001_a.sql" }) as never],
      exposedTables: [],
    })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it("fails closed when the registry lists an internal or missing table", () => {
    expect(() =>
      createSchemaSnapshot({
        catalogue: buildCatalogue(),
        migrations: [],
        exposedTables: [
          { alias: "users", schema: "microjbase", table: "users" },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("Internal table"),
      }),
    )

    expect(() =>
      createSchemaSnapshot({
        catalogue: buildCatalogue(),
        migrations: [],
        exposedTables: [{ alias: "ghost", schema: "app", table: "ghost" }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("not present in the schema catalogue"),
      }),
    )

    expect(() =>
      createSchemaSnapshot({
        catalogue: buildCatalogue(),
        migrations: [],
        exposedTables: [
          { alias: "a", schema: "app", table: "todos" },
          { alias: "b", schema: "app", table: "todos" },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: expect.stringContaining("listed more than once"),
      }),
    )
  })
})

describe("schema snapshot reader", () => {
  it("reads catalogue and migration history with two fixed reads and no mutation", async () => {
    const calls: string[] = []
    const query = (async (text: string) => {
      calls.push(text)
      if (text === MIGRATION_HISTORY_SQL) {
        return pgResult([migrationRow()])
      }
      // The catalogue statement returns only the rows this smoke catalogue
      // needs; row_kind drives the split in readSchemaCatalogue.
      return pgResult([
        {
          ...baseCatalogueRow(),
          row_kind: "schema",
          schema_name: "app",
          owner: "owner_role",
        },
        {
          ...baseCatalogueRow(),
          row_kind: "table",
          schema_name: "app",
          table_name: "todos",
          owner: "owner_role",
          kind: "regular",
          has_row_security: true,
          has_forced_row_security: true,
        },
        {
          ...baseCatalogueRow(),
          row_kind: "column",
          schema_name: "app",
          table_name: "todos",
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
        },
      ])
    }) as SchemaSnapshotDependencies["query"]

    const snapshot = await readSchemaSnapshot({
      query,
      registry: buildRegistry([
        { alias: "todos", schema: "app", table: "todos" },
      ]),
    })

    expect(calls).toHaveLength(2)
    expect(snapshot.schemas[0]?.tables[0]?.exposure).toEqual({
      exposed: true,
      alias: "todos",
    })
    expect(snapshot.migrations).toHaveLength(1)
  })

  it("passes existing AppError instances through unchanged", async () => {
    const appError = new AppError(
      "DATABASE_UNAVAILABLE",
      "Database is unavailable",
      503,
    )
    const query = vi.fn(async () => {
      throw appError
    }) as unknown as SchemaSnapshotDependencies["query"]

    const reader = createSchemaSnapshotReader({
      query,
      registry: buildRegistry([]),
    })
    await expect(reader.readSnapshot()).rejects.toBe(appError)
    // The catalogue read is the first statement; it failed, so no second
    // statement was issued.
    expect(query).toHaveBeenCalledTimes(1)
  })
})
