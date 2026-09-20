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

interface ColumnMeta {
  name: string
  dataType: string
  isNullable: boolean
  isGenerated: boolean
  isIdentity: boolean
  hasDefault: boolean
  isUpdatable: boolean
}

interface TableVerification {
  schema: string
  table: string
  hasRls: boolean
  hasForceRls: boolean
  applicablePolicy: boolean
  primaryKey: { column: string; dataType: string } | null
  columns: readonly ColumnMeta[]
  privileges: {
    hasSelect: boolean
    hasInsert: boolean
    hasUpdate: boolean
    hasDelete: boolean
  }
}

const SUPPORTED_TYPES = new Map<
  string,
  "string" | "number" | "boolean" | "json" | "timestamp"
>([
  ["uuid", "string"],
  ["text", "string"],
  ["varchar", "string"],
  ["character varying", "string"],
  ["char", "string"],
  ["character", "string"],
  ["boolean", "boolean"],
  ["bool", "boolean"],
  ["smallint", "number"],
  ["integer", "number"],
  ["int", "number"],
  ["int4", "number"],
  ["real", "number"],
  ["float4", "number"],
  ["double precision", "number"],
  ["float8", "number"],
  ["bigint", "string"],
  ["int8", "string"],
  ["numeric", "string"],
  ["decimal", "string"],
  ["date", "timestamp"],
  ["timestamp without time zone", "timestamp"],
  ["timestamp", "timestamp"],
  ["timestamp with time zone", "timestamp"],
  ["timestamptz", "timestamp"],
  ["json", "json"],
  ["jsonb", "json"],
])

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

    const readableColumns: string[] = []
    const insertableColumns: string[] = []
    const updatableColumns: string[] = []

    for (const column of verified.columns) {
      if (!SUPPORTED_TYPES.has(column.dataType)) {
        continue
      }

      if (verified.privileges.hasSelect) {
        readableColumns.push(column.name)
      }

      if (
        verified.privileges.hasInsert &&
        column.name !== "id" &&
        !column.isGenerated &&
        !column.isIdentity
      ) {
        insertableColumns.push(column.name)
      }

      if (
        verified.privileges.hasUpdate &&
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

    if (updatableColumns.length === 0) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Table ${mapping.schema}.${mapping.table} has no updatable columns`,
        503,
        { alias: mapping.alias, schema: mapping.schema, table: mapping.table },
      )
    }

    exposedTables.push({
      alias: mapping.alias,
      schema: mapping.schema,
      table: mapping.table,
      primaryKey: "id",
      readableColumns,
      insertableColumns,
      updatableColumns,
    })
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

  const privilegeResult = await query<{
    has_select: boolean
    has_insert: boolean
    has_update: boolean
    has_delete: boolean
  }>(
    `SELECT
       has_table_privilege(current_user, $1, 'SELECT') AS has_select,
       has_table_privilege(current_user, $1, 'INSERT') AS has_insert,
       has_table_privilege(current_user, $1, 'UPDATE') AS has_update,
       has_table_privilege(current_user, $1, 'DELETE') AS has_delete`,
    [`${schema}.${table}`],
  )
  const privilegeRow = privilegeResult.rows[0]
  if (privilegeRow === undefined) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      `Could not determine privileges on ${schema}.${table}`,
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

  const columns: ColumnMeta[] = columnsResult.rows
    .filter(
      (row) =>
        SUPPORTED_TYPES.has(normalizeType(row.data_type)) &&
        row.is_generated === "NEVER" &&
        row.is_identity === "NO",
    )
    .map((row) => ({
      name: row.column_name,
      dataType: normalizeType(row.data_type),
      isNullable: row.is_nullable === "YES",
      isGenerated: false,
      isIdentity: false,
      hasDefault: row.column_default !== null,
      isUpdatable: true,
    }))

  return {
    schema,
    table,
    hasRls: rlsRow.relrowsecurity,
    hasForceRls: rlsRow.relforcerowsecurity,
    applicablePolicy,
    primaryKey,
    columns,
    privileges: {
      hasSelect: privilegeRow.has_select,
      hasInsert: privilegeRow.has_insert,
      hasUpdate: privilegeRow.has_update,
      hasDelete: privilegeRow.has_delete,
    },
  }
}

function normalizeType(typeName: string): string {
  const lower = typeName.toLowerCase().trim()
  if (lower === "character varying") return "varchar"
  if (lower === "timestamp without time zone") return "timestamp"
  if (lower === "timestamp with time zone") return "timestamptz"
  return lower
}

export function quoteTableIdentifier(schema: string, table: string): string {
  return quoteQualifiedName(schema, table)
}

export { quoteIdentifier }
