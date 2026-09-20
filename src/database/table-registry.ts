// PostgreSQL table registry for microJBase v0.1.
//
// The registry parses the operator-configured alias=schema.table mappings,
// verifies them against PostgreSQL metadata, and stores immutable metadata
// used by the data repository. Verification fails closed: unsafe or unusable
// tables prevent startup.

import type pg from "pg"

import { AppError } from "../core/index.js"
import type { ExposedTable, TableRegistry } from "../contracts/index.js"

import { quoteIdentifier, quoteQualifiedName } from "./identifier.js"
import {
  type ColumnMetadata,
  attachPrivateMetadata,
  isSupportedType,
  normalizeType,
} from "./table-types.js"

export { type ExposedTable, type TableRegistry }

export interface ExposedTableMapping {
  alias: string
  schema: string
  table: string
}

export interface TableRegistryConfig {
  mappings: readonly ExposedTableMapping[]
}

export interface RegistryBuildDependencies {
  query: <R extends pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<R>>
}

interface TableVerification {
  schema: string
  table: string
  hasRls: boolean
  hasForceRls: boolean
  applicablePolicy: boolean
  primaryKey: { column: string; dataType: string } | null
  columns: readonly ColumnMetadata[]
  hasDelete: boolean
}

const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/i
const FORBIDDEN_SCHEMAS = new Set([
  "microjbase",
  "pg_catalog",
  "information_schema",
])

function assertIdentifier(name: string, context: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      `Invalid ${context} identifier: ${name}`,
      503,
      { [context]: name },
    )
  }
}

function parseMappings(
  raw: string | undefined,
): readonly ExposedTableMapping[] {
  if (raw === undefined || raw.trim().length === 0) {
    return []
  }

  const entries = raw.split(",").map((entry) => entry.trim())
  const seenAliases = new Set<string>()
  const seenTargets = new Set<string>()
  const mappings: ExposedTableMapping[] = []

  for (const entry of entries) {
    if (entry.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "MICROJBASE_TABLES contains an empty entry",
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }

    const separatorIndex = entry.indexOf("=")
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new AppError(
        "VALIDATION_ERROR",
        `MICROJBASE_TABLES entry "${entry}" must be in the form alias=schema.table`,
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }

    const alias = entry.slice(0, separatorIndex).trim()
    const target = entry.slice(separatorIndex + 1).trim()

    if (!ALIAS_PATTERN.test(alias)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `MICROJBASE_TABLES alias "${alias}" must match ${ALIAS_PATTERN.source}`,
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }

    const parsed = parseTableTarget(target)

    if (seenAliases.has(alias)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `MICROJBASE_TABLES alias "${alias}" is defined more than once`,
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }
    seenAliases.add(alias)

    const targetKey = `${parsed.schema}.${parsed.table}`
    if (seenTargets.has(targetKey)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `MICROJBASE_TABLES target "${targetKey}" is mapped more than once`,
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }
    seenTargets.add(targetKey)

    mappings.push({ alias, schema: parsed.schema, table: parsed.table })
  }

  return mappings
}

function parseTableTarget(target: string): { schema: string; table: string } {
  const parts = target.split(".")
  if (parts.length !== 2 || parts[0]?.length === 0 || parts[1]?.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MICROJBASE_TABLES target "${target}" must be schema.table`,
      400,
      { variable: "MICROJBASE_TABLES" },
    )
  }
  const schema = parts[0] as string
  const table = parts[1] as string

  if (FORBIDDEN_SCHEMAS.has(schema.toLowerCase())) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MICROJBASE_TABLES schema "${schema}" cannot be exposed`,
      400,
      { variable: "MICROJBASE_TABLES" },
    )
  }

  return { schema, table }
}

class VerifiedTableRegistry implements TableRegistry {
  private readonly tables: Map<string, ExposedTable>

  constructor(tables: readonly ExposedTable[]) {
    this.tables = new Map(tables.map((t) => [t.alias, t]))
  }

  get(alias: string): ExposedTable | null {
    return this.tables.get(alias) ?? null
  }

  list(): readonly ExposedTable[] {
    return Array.from(this.tables.values())
  }
}

export async function buildTableRegistry(
  config: TableRegistryConfig,
  deps: RegistryBuildDependencies,
): Promise<TableRegistry> {
  if (config.mappings.length === 0) {
    return new VerifiedTableRegistry([])
  }

  const exposedTables: ExposedTable[] = []

  for (const mapping of config.mappings) {
    assertIdentifier(mapping.schema, "schema")
    assertIdentifier(mapping.table, "table")

    const verified = await verifyTable(deps.query, mapping)

    if (!verified.hasRls) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Row-level security is not enabled on ${mapping.schema}.${mapping.table}`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    if (!verified.hasForceRls) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Forced row-level security is not enabled on ${mapping.schema}.${mapping.table}`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    if (!verified.applicablePolicy) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `No row-level security policies on ${mapping.schema}.${mapping.table} apply to the runtime role`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    if (verified.primaryKey === null) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Table ${mapping.schema}.${mapping.table} has no single-column primary key`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    if (verified.primaryKey.column !== "id") {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Primary key on ${mapping.schema}.${mapping.table} must be named "id"`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    if (verified.primaryKey.dataType !== "uuid") {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Primary key "id" on ${mapping.schema}.${mapping.table} must be type uuid`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    if (!verified.hasDelete) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Runtime role cannot delete from ${mapping.schema}.${mapping.table}`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    const readableColumns: string[] = []
    const insertableColumns: string[] = []
    const updatableColumns: string[] = []
    const columnTypes: Record<string, string> = {}

    for (const column of verified.columns) {
      columnTypes[column.name] = column.dataType

      if (column.hasSelect) {
        readableColumns.push(column.name)
      }

      if (column.hasInsert && !column.isGenerated && !column.isIdentity) {
        insertableColumns.push(column.name)
      }

      if (
        column.hasUpdate &&
        column.name !== "id" &&
        !column.isGenerated &&
        !column.isIdentity
      ) {
        updatableColumns.push(column.name)
      }
    }

    if (readableColumns.length === 0) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Table ${mapping.schema}.${mapping.table} has no readable columns`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    if (insertableColumns.length === 0) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Table ${mapping.schema}.${mapping.table} has no insertable columns`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    // The contract exposes a single deleteById operation; a table without a
    // DELETE privilege would always fail at runtime, so fail closed at startup.
    if (!verified.hasDelete) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Runtime role cannot delete from ${mapping.schema}.${mapping.table}`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    // Updatable columns may legitimately be empty if the operator only exposes
    // INSERT/SELECT/DELETE, but the frozen DataRepository contract exposes
    // updateById. Fail closed so the mismatch is visible at startup.
    if (updatableColumns.length === 0) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Table ${mapping.schema}.${mapping.table} has no updatable columns`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    const exposedTable: ExposedTable = Object.freeze({
      alias: mapping.alias,
      schema: mapping.schema,
      table: mapping.table,
      primaryKey: "id",
      readableColumns: Object.freeze([...readableColumns]),
      insertableColumns: Object.freeze([...insertableColumns]),
      updatableColumns: Object.freeze([...updatableColumns]),
    })

    attachPrivateMetadata(exposedTable, { columnTypes })
    exposedTables.push(exposedTable)
  }

  return new VerifiedTableRegistry(exposedTables)
}

export async function buildTableRegistryFromEnv(
  raw: string | undefined,
  deps: RegistryBuildDependencies,
): Promise<TableRegistry> {
  const mappings = parseMappings(raw)
  return buildTableRegistry({ mappings }, deps)
}

async function verifyTable(
  query: <R extends pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<R>>,
  mapping: ExposedTableMapping,
): Promise<TableVerification> {
  const { schema, table } = mapping

  const schemaUsageResult = await query<{ has: boolean }>(
    "SELECT has_schema_privilege(current_user, $1, 'USAGE') AS has",
    [schema],
  )
  const schemaUsageRow = schemaUsageResult.rows[0]
  if (schemaUsageRow === undefined || !schemaUsageRow.has) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      `Runtime role is missing USAGE privilege on schema ${schema}`,
      503,
      { alias: mapping.alias, schema, table },
    )
  }

  const existsResult = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
     ) AS exists`,
    [schema, table],
  )
  const existsRow = existsResult.rows[0]
  if (existsRow === undefined || !existsRow.exists) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      `Configured table ${schema}.${table} does not exist`,
      503,
      { alias: mapping.alias, schema, table },
    )
  }

  const rlsResult = await query<{
    relrowsecurity: boolean
    relforcerowsecurity: boolean
  }>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    [schema, table],
  )
  const rlsRow = rlsResult.rows[0]
  if (rlsRow === undefined) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      `Configured table ${schema}.${table} does not exist`,
      503,
      { alias: mapping.alias, schema, table },
    )
  }

  const deleteResult = await query<{ has: boolean }>(
    "SELECT has_table_privilege(current_user, $1, 'DELETE') AS has",
    [`${schema}.${table}`],
  )
  const deleteRow = deleteResult.rows[0]
  if (deleteRow === undefined) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      `Could not determine DELETE privilege on ${schema}.${table}`,
      503,
      { alias: mapping.alias, schema, table },
    )
  }

  const policyResult = await query<{
    applicable_to_current_user: boolean
  }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_policy pol
       JOIN pg_class c ON c.oid = pol.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
       AND (
         pol.polroles = ARRAY[0]::oid[]
         OR EXISTS (
           SELECT 1 FROM unnest(pol.polroles) AS policy_role
           WHERE pg_has_role(current_user, policy_role, 'MEMBER')
         )
       )
     ) AS applicable_to_current_user`,
    [schema, table],
  )
  const policyRow = policyResult.rows[0]
  const applicablePolicy = policyRow?.applicable_to_current_user ?? false

  const pkResult = await query<{
    column_name: string
    data_type: string
  }>(
    `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`,
    [schema, table],
  )

  const primaryKey: { column: string; dataType: string } | null =
    pkResult.rows.length === 1 && pkResult.rows[0] !== undefined
      ? {
          column: pkResult.rows[0].column_name,
          dataType: normalizeType(pkResult.rows[0].data_type),
        }
      : null

  const columnsResult = await query<{
    column_name: string
    data_type: string
    is_nullable: string
    column_default: string | null
    is_generated: string
    is_identity: string
  }>(
    `SELECT column_name, data_type, is_nullable, column_default,
            is_generated, is_identity
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table],
  )

  const columnPrivileges = await query<{
    column_name: string
    has_select: boolean
    has_insert: boolean
    has_update: boolean
  }>(
    `SELECT a.attname AS column_name,
            has_column_privilege(current_user, c.oid, a.attnum, 'SELECT') AS has_select,
            has_column_privilege(current_user, c.oid, a.attnum, 'INSERT') AS has_insert,
            has_column_privilege(current_user, c.oid, a.attnum, 'UPDATE') AS has_update
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [schema, table],
  )
  const privilegesByColumn = new Map(
    columnPrivileges.rows.map((row) => [
      row.column_name,
      {
        hasSelect: row.has_select,
        hasInsert: row.has_insert,
        hasUpdate: row.has_update,
      },
    ]),
  )

  const columns: ColumnMetadata[] = columnsResult.rows
    .filter((row) => isSupportedType(row.data_type))
    .map((row) => {
      const privileges = privilegesByColumn.get(row.column_name) ?? {
        hasSelect: false,
        hasInsert: false,
        hasUpdate: false,
      }
      return {
        name: row.column_name,
        dataType: normalizeType(row.data_type),
        isNullable: row.is_nullable === "YES",
        isGenerated: row.is_generated !== "NEVER",
        isIdentity: row.is_identity === "YES",
        hasDefault: row.column_default !== null,
        ...privileges,
      }
    })

  return {
    schema,
    table,
    hasRls: rlsRow.relrowsecurity,
    hasForceRls: rlsRow.relforcerowsecurity,
    applicablePolicy,
    primaryKey,
    columns,
    hasDelete: deleteRow.has,
  }
}

export function quoteTableIdentifier(schema: string, table: string): string {
  return quoteQualifiedName(schema, table)
}

export { quoteIdentifier }
