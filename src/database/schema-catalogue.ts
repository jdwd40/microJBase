// Read-only PostgreSQL schema-catalogue reader for microJBase v0.2 (V02-01).
//
// The reader executes three fixed, read-only catalogue SELECT statements
// against pg_namespace/pg_class/pg_attribute/pg_type/pg_attrdef. No caller
// identifier or SQL fragment ever enters the query text; quoted or
// hostile-looking schema/table/column names are returned as data only.
// There is no mutation path: the reader issues SELECTs and maps rows.
//
// The query capability is injected by the caller; this module never
// constructs a production pool. V02-04 introduces the schema-admin
// connection boundary that will inject it in production.

import type pg from "pg"

import type {
  ColumnGeneratedKind,
  ColumnIdentityKind,
  SchemaCatalogue,
  SchemaCatalogueColumn,
  SchemaCatalogueReader,
  SchemaCatalogueSchema,
  SchemaCatalogueTable,
  SchemaTableKind,
  TypeIdentity,
} from "../contracts/index.js"
import { AppError } from "../core/index.js"

import { translatePoolError } from "./pool.js"

/**
 * Injected query capability. Structurally identical to the query surface
 * used by the existing database adapters, so a Pool, PoolClient, or test
 * double can be supplied directly.
 */
export interface SchemaCatalogueDependencies {
  query: <R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<R>>
}

// Fixed read-only catalogue statements. Exported for unit tests that pin
// the query shape; not part of the public module surface.
export const SCHEMA_CATALOGUE_SCHEMAS_SQL = `SELECT n.nspname AS schema_name,
       pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY n.nspname`

export const SCHEMA_CATALOGUE_TABLES_SQL = `SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner,
       CASE c.relkind WHEN 'p' THEN 'partitioned' ELSE 'regular' END AS kind,
       c.relrowsecurity AS has_row_security,
       c.relforcerowsecurity AS has_forced_row_security
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY n.nspname, c.relname`

export const SCHEMA_CATALOGUE_COLUMNS_SQL = `SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       a.attnum AS ordinal,
       a.attname AS name,
       (NOT a.attnotnull) AS is_nullable,
       pg_get_expr(d.adbin, d.adrelid) AS default_expression,
       a.attgenerated AS generated,
       a.attidentity AS identity,
       format_type(a.atttypid, a.atttypmod) AS rendered_type,
       tn.nspname AS type_schema,
       ty.typname AS type_name,
       ty.typtype AS type_kind,
       bn.nspname AS base_type_schema,
       bt.typname AS base_type_name,
       bt.typtype AS base_type_kind
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
JOIN pg_type ty ON ty.oid = a.atttypid
JOIN pg_namespace tn ON tn.oid = ty.typnamespace
LEFT JOIN pg_type bt ON bt.oid = ty.typbasetype
LEFT JOIN pg_namespace bn ON bn.oid = bt.typnamespace
WHERE a.attnum > 0
  AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p')
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY n.nspname, c.relname, a.attnum`

// Raw catalogue row shapes as returned by the fixed queries. Exported for
// the unit tests; not part of the public module surface.
export interface SchemaCatalogueSchemaRow {
  schema_name: unknown
  owner: unknown
}

export interface SchemaCatalogueTableRow {
  schema_name: unknown
  table_name: unknown
  owner: unknown
  kind: unknown
  has_row_security: unknown
  has_forced_row_security: unknown
}

export interface SchemaCatalogueColumnRow {
  schema_name: unknown
  table_name: unknown
  ordinal: unknown
  name: unknown
  is_nullable: unknown
  default_expression: unknown
  generated: unknown
  identity: unknown
  rendered_type: unknown
  type_schema: unknown
  type_name: unknown
  type_kind: unknown
  base_type_schema: unknown
  base_type_name: unknown
  base_type_kind: unknown
}

function malformed(reason: string): AppError {
  return new AppError(
    "INTERNAL_ERROR",
    `Malformed schema catalogue row: ${reason}`,
    500,
  )
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(`${field} must be a non-empty string`)
  }
  return value
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw malformed(`${field} must be a boolean`)
  }
  return value
}

function requireOrdinal(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw malformed("ordinal must be a positive integer")
  }
  return value
}

function mapTypeKind(value: unknown, field: string): TypeIdentity["kind"] {
  switch (value) {
    case "b":
      return "base"
    case "d":
      return "domain"
    case "e":
      return "enum"
    case "r":
      return "range"
    case "m":
      return "multirange"
    case "c":
      return "composite"
    case "p":
      return "pseudo"
    default:
      throw malformed(`${field} has unsupported type kind`)
  }
}

function mapTableKind(value: unknown): SchemaTableKind {
  if (value === "regular" || value === "partitioned") {
    return value
  }
  throw malformed("kind must be regular or partitioned")
}

function mapGenerated(value: unknown): ColumnGeneratedKind {
  if (value === "") {
    return "none"
  }
  if (value === "s") {
    return "stored"
  }
  throw malformed("generated must be empty or 's'")
}

function mapIdentity(value: unknown): ColumnIdentityKind {
  if (value === "") {
    return "none"
  }
  if (value === "a") {
    return "always"
  }
  if (value === "d") {
    return "by_default"
  }
  throw malformed("identity must be empty, 'a', or 'd'")
}

function mapColumn(row: SchemaCatalogueColumnRow): SchemaCatalogueColumn {
  const generated = mapGenerated(row.generated)
  const defaultExpression =
    generated === "none" && row.default_expression !== null
      ? requireString(row.default_expression, "default_expression")
      : null

  const type: TypeIdentity = Object.freeze({
    schema: requireString(row.type_schema, "type_schema"),
    name: requireString(row.type_name, "type_name"),
    kind: mapTypeKind(row.type_kind, "type_kind"),
  })

  const baseType: TypeIdentity | null =
    row.base_type_name === null
      ? null
      : Object.freeze({
          schema: requireString(row.base_type_schema, "base_type_schema"),
          name: requireString(row.base_type_name, "base_type_name"),
          kind: mapTypeKind(row.base_type_kind, "base_type_kind"),
        })

  return Object.freeze({
    ordinal: requireOrdinal(row.ordinal),
    name: requireString(row.name, "name"),
    isNullable: requireBoolean(row.is_nullable, "is_nullable"),
    defaultExpression,
    generated,
    identity: mapIdentity(row.identity),
    renderedType: requireString(row.rendered_type, "rendered_type"),
    type,
    baseType,
  })
}

function compareByName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

/**
 * Group catalogue rows into the deterministic public model. Sorting happens
 * here (by schema name, table name, column ordinal) so results are
 * deterministic regardless of input row order or database collation.
 */
export function mapSchemaCatalogue(
  schemaRows: readonly SchemaCatalogueSchemaRow[],
  tableRows: readonly SchemaCatalogueTableRow[],
  columnRows: readonly SchemaCatalogueColumnRow[],
): SchemaCatalogue {
  const columnsByTable = new Map<string, Map<string, SchemaCatalogueColumn[]>>()
  for (const row of columnRows) {
    const schemaName = requireString(row.schema_name, "schema_name")
    const tableName = requireString(row.table_name, "table_name")
    let tableMap = columnsByTable.get(schemaName)
    if (tableMap === undefined) {
      tableMap = new Map()
      columnsByTable.set(schemaName, tableMap)
    }
    const columns = tableMap.get(tableName)
    if (columns === undefined) {
      tableMap.set(tableName, [mapColumn(row)])
    } else {
      columns.push(mapColumn(row))
    }
  }

  const tablesBySchema = new Map<string, SchemaCatalogueTable[]>()
  for (const row of tableRows) {
    const schemaName = requireString(row.schema_name, "schema_name")
    const tableName = requireString(row.table_name, "table_name")
    const columns = columnsByTable.get(schemaName)?.get(tableName) ?? []
    columns.sort((a, b) => a.ordinal - b.ordinal)

    const table: SchemaCatalogueTable = Object.freeze({
      schema: schemaName,
      name: tableName,
      owner: requireString(row.owner, "owner"),
      kind: mapTableKind(row.kind),
      hasRowSecurity: requireBoolean(row.has_row_security, "has_row_security"),
      hasForcedRowSecurity: requireBoolean(
        row.has_forced_row_security,
        "has_forced_row_security",
      ),
      columns: Object.freeze(columns),
    })

    const tables = tablesBySchema.get(schemaName)
    if (tables === undefined) {
      tablesBySchema.set(schemaName, [table])
    } else {
      tables.push(table)
    }
  }

  const schemas: SchemaCatalogueSchema[] = []
  for (const row of schemaRows) {
    const name = requireString(row.schema_name, "schema_name")
    const tables = tablesBySchema.get(name) ?? []
    tables.sort(compareByName)
    schemas.push(
      Object.freeze({
        name,
        owner: requireString(row.owner, "owner"),
        tables: Object.freeze(tables),
      }),
    )
  }
  schemas.sort(compareByName)

  return Object.freeze({ schemas: Object.freeze(schemas) })
}

/**
 * Execute the three fixed catalogue reads and map them into the frozen
 * contract model. Dependency errors pass through the existing safe
 * database error translation boundary.
 */
export async function readSchemaCatalogue(
  query: SchemaCatalogueDependencies["query"],
): Promise<SchemaCatalogue> {
  let schemaResult: pg.QueryResult<SchemaCatalogueSchemaRow>
  let tableResult: pg.QueryResult<SchemaCatalogueTableRow>
  let columnResult: pg.QueryResult<SchemaCatalogueColumnRow>

  try {
    schemaResult = await query<SchemaCatalogueSchemaRow>(
      SCHEMA_CATALOGUE_SCHEMAS_SQL,
    )
    tableResult = await query<SchemaCatalogueTableRow>(
      SCHEMA_CATALOGUE_TABLES_SQL,
    )
    columnResult = await query<SchemaCatalogueColumnRow>(
      SCHEMA_CATALOGUE_COLUMNS_SQL,
    )
  } catch (error: unknown) {
    throw translatePoolError(error)
  }

  return mapSchemaCatalogue(
    schemaResult.rows,
    tableResult.rows,
    columnResult.rows,
  )
}

/** Create a read-only schema-catalogue reader over an injected query. */
export function createSchemaCatalogueReader(
  deps: SchemaCatalogueDependencies,
): SchemaCatalogueReader {
  return Object.freeze({
    read: () => readSchemaCatalogue(deps.query),
  })
}
