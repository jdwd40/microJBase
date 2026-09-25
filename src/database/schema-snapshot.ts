// Read-only schema-snapshot assembly for microJBase v0.2 (V02-03).
//
// A snapshot is the immutable, deterministically ordered point-in-time state
// of the database schema surface microJBase manages. It is assembled from
// three read-only inputs:
//
// 1. the V02-01/V02-02 schema catalogue (one fixed pinned statement),
// 2. the forward-only migration history from microjbase.schema_migrations
//    (one additional fixed read-only statement; the table is written only by
//    the migration command, never by request handlers),
// 3. the current data-API exposure state from the v0.1 table registry
//    (in-memory, immutable verified metadata).
//
// No path in this module mutates the database. The catalogue read keeps its
// single-statement/single-snapshot property; the migration history is
// immutable between migration-command runs, so reading it in a second
// statement cannot stitch together a state that management would misread.
//
// Internal objects (microjbase, pg_catalog, information_schema, and any
// pg_* name) are classified "internal" and are never presented as
// manageable; a registry that somehow lists an internal or missing table
// fails closed instead of being silently normalized.
//
// The query capability and the v0.1 TableRegistry are injected by the
// caller; this module never constructs a production pool. V02-04 introduces
// the schema-admin connection boundary that will inject the query in
// production, and V02-10 introduces the durable exposure registry that will
// replace the v0.1 registry as this input.

import type pg from "pg"

import type {
  SchemaCatalogue,
  SchemaMigrationRecord,
  SchemaObjectClassification,
  SchemaSnapshot,
  SchemaSnapshotReader,
  SchemaSnapshotSchema,
  SchemaSnapshotTable,
  TableRegistry,
} from "../contracts/index.js"
import { AppError } from "../core/index.js"

import { translatePoolError } from "./pool.js"
import {
  createSchemaCatalogueReader,
  type SchemaCatalogueDependencies,
} from "./schema-catalogue.js"

/**
 * Fixed read-only migration-history statement. applied_at renders as a
 * deterministic UTC ISO-8601 string so snapshots are byte-stable regardless
 * of the session timezone; rows are sorted by filename.
 */
export const MIGRATION_HISTORY_SQL = `SELECT filename,
       checksum,
       to_char(applied_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_at
FROM microjbase.schema_migrations
ORDER BY filename`

export interface SchemaSnapshotDependencies {
  query: SchemaCatalogueDependencies["query"]
  registry: TableRegistry
}

// Exposed-table identity needed for assembly; structurally satisfied by the
// v0.1 ExposedTable contract.
export interface SchemaSnapshotExposedTable {
  readonly alias: string
  readonly schema: string
  readonly table: string
}

export interface SchemaSnapshotInput {
  readonly catalogue: SchemaCatalogue
  readonly migrations: readonly SchemaMigrationRecord[]
  readonly exposedTables: readonly SchemaSnapshotExposedTable[]
}

// Raw migration-history row shape; exported for the unit tests.
export interface MigrationHistoryRow {
  filename: unknown
  checksum: unknown
  applied_at: unknown
}

// Deterministic rendering produced by MIGRATION_HISTORY_SQL (to_char with
// the UTC-fixed pattern, always six fractional digits).
const APPLIED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

const INTERNAL_SCHEMA_NAMES = new Set([
  "microjbase",
  "pg_catalog",
  "information_schema",
])

export function classifySchemaObject(
  schemaName: string,
): SchemaObjectClassification {
  if (INTERNAL_SCHEMA_NAMES.has(schemaName) || schemaName.startsWith("pg_")) {
    return "internal"
  }
  return "operator"
}

function malformedMigration(reason: string): AppError {
  return new AppError(
    "INTERNAL_ERROR",
    `Malformed schema migration row: ${reason}`,
    500,
  )
}

function requireMigrationString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformedMigration(`${field} must be a non-empty string`)
  }
  return value
}

/**
 * Validate and order migration-history rows. Duplicate filenames fail
 * closed; the input order does not matter because the output is sorted by
 * filename.
 */
export function mapMigrationHistory(
  rows: readonly MigrationHistoryRow[],
): readonly SchemaMigrationRecord[] {
  const byFilename = new Map<string, SchemaMigrationRecord>()
  for (const row of rows) {
    const filename = requireMigrationString(row.filename, "filename")
    if (byFilename.has(filename)) {
      throw malformedMigration(`duplicate migration filename "${filename}"`)
    }
    const checksum = requireMigrationString(row.checksum, "checksum")
    const appliedAt = requireMigrationString(row.applied_at, "applied_at")
    if (!APPLIED_AT_PATTERN.test(appliedAt)) {
      throw malformedMigration(
        `applied_at must be a UTC ISO-8601 rendering, got "${appliedAt}"`,
      )
    }
    byFilename.set(filename, Object.freeze({ filename, checksum, appliedAt }))
  }
  return Object.freeze(
    [...byFilename.values()].sort((a, b) => (a.filename < b.filename ? -1 : 1)),
  )
}

/**
 * Execute the fixed migration-history read and map it. Dependency errors
 * pass through the existing safe database error translation boundary.
 */
export async function readMigrationHistory(
  query: SchemaSnapshotDependencies["query"],
): Promise<readonly SchemaMigrationRecord[]> {
  let result: pg.QueryResult<MigrationHistoryRow>
  try {
    result = await query<MigrationHistoryRow>(MIGRATION_HISTORY_SQL)
  } catch (error: unknown) {
    throw translatePoolError(error)
  }
  return mapMigrationHistory(result.rows)
}

/**
 * Startup probe for the D-037.6 grant: the admin lane reads migration
 * history through MIGRATION_HISTORY_SQL, so the schema-admin role must hold
 * SELECT on microjbase.schema_migrations. Migrations 0005/0006 could not
 * grant it (the role did not exist at migration time), so the operator
 * grants it out of band; probe here and fail startup with a clear message
 * rather than letting the first snapshot read die later as a 500.
 */
export async function checkSchemaMigrationsReadAccess(
  client: pg.Client | pg.PoolClient,
): Promise<void> {
  const result = await client.query<{ has: boolean }>(
    "SELECT has_table_privilege(current_user, $1, $2) AS has",
    ["microjbase.schema_migrations", "SELECT"],
  )
  const row = result.rows[0]
  if (row === undefined || !row.has) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Schema-admin database role is missing required privilege SELECT on microjbase.schema_migrations",
      503,
      { object: "microjbase.schema_migrations", privilege: "SELECT" },
    )
  }
}

/**
 * Assemble the immutable snapshot. Exposure targets must exist in the
 * catalogue and must never be internal; both violations fail closed with
 * INTERNAL_ERROR rather than being silently normalized or dropped.
 * Everything returned is frozen; sorting is defensive so the output is
 * deterministic regardless of input order.
 */
export function createSchemaSnapshot(
  input: SchemaSnapshotInput,
): SchemaSnapshot {
  const exposureByTarget = new Map<string, string>()
  for (const exposed of input.exposedTables) {
    const key = `${exposed.schema}.${exposed.table}`
    if (exposureByTarget.has(key)) {
      throw new AppError(
        "INTERNAL_ERROR",
        `Exposed table "${key}" is listed more than once`,
        500,
      )
    }
    exposureByTarget.set(key, exposed.alias)
  }

  const schemas: SchemaSnapshotSchema[] = []
  for (const schema of input.catalogue.schemas) {
    const classification = classifySchemaObject(schema.name)
    const tables: SchemaSnapshotTable[] = []
    for (const table of schema.tables) {
      const key = `${table.schema}.${table.name}`
      const alias = exposureByTarget.get(key)
      exposureByTarget.delete(key)
      const tableClassification = classifySchemaObject(table.schema)
      if (alias !== undefined && tableClassification === "internal") {
        throw new AppError(
          "INTERNAL_ERROR",
          `Internal table "${key}" cannot be exposed to the data API`,
          500,
        )
      }
      tables.push(
        Object.freeze({
          ...table,
          classification: tableClassification,
          exposure: Object.freeze({
            exposed: alias !== undefined,
            alias: alias ?? null,
          }),
        }),
      )
    }
    schemas.push(
      Object.freeze({
        name: schema.name,
        owner: schema.owner,
        classification,
        tables: Object.freeze(tables),
      }),
    )
  }

  // Any remaining exposure entry has no matching catalogue table: the
  // registry is stale relative to the database, and the snapshot must not
  // pretend otherwise.
  const stale = [...exposureByTarget.keys()].sort()
  if (stale.length > 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      `Exposed table "${stale[0]}" is not present in the schema catalogue`,
      500,
    )
  }

  return Object.freeze({
    schemas: Object.freeze(schemas),
    migrations: Object.freeze(
      [...input.migrations].sort((a, b) => (a.filename < b.filename ? -1 : 1)),
    ),
  })
}

/**
 * Read catalogue plus migration history and assemble the snapshot in one
 * call. Two fixed read-only statements are issued per snapshot; nothing is
 * mutated.
 */
export async function readSchemaSnapshot(
  deps: SchemaSnapshotDependencies,
): Promise<SchemaSnapshot> {
  const catalogue = await createSchemaCatalogueReader(deps).read()
  const migrations = await readMigrationHistory(deps.query)
  return createSchemaSnapshot({
    catalogue,
    migrations,
    exposedTables: deps.registry.list(),
  })
}

/** Create a read-only schema-snapshot reader over injected dependencies. */
export function createSchemaSnapshotReader(
  deps: SchemaSnapshotDependencies,
): SchemaSnapshotReader {
  return Object.freeze({
    readSnapshot: () => readSchemaSnapshot(deps),
  })
}
