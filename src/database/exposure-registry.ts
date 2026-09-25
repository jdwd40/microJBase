// Durable API-exposure registry storage for microJBase v0.2 (V02-10, D-018).
//
// The registry separates "table exists" from "table is exposed to the data
// API". Migration 0006 owns the tables; this module owns the typed reads
// both lanes use and the one-time import call:
//
// - Runtime lane (restricted role): reads the singleton state row and the
//   exposed=true rows through the injected query function, then verifies
//   them through the v0.1 table-registry builder. The durable registry is
//   the sole runtime exposure source: after initialization, MICROJBASE_TABLES
//   is never consulted again.
// - One-time import: importInitialExposure invokes the audited SECURITY
//   DEFINER function from migration 0006 (PUBLIC EXECUTE revoked by migration
//   0007; only the runtime role holds EXECUTE). The function validates the
//   payload independently and refuses a second call, so neither the
//   environment variable nor any caller can add or re-expose tables after
//   the import. A failed call re-reads the state: if another process won the
//   race with the SAME exposed set, its initialized state is returned so
//   startup proceeds once; a winner with a different set is a CONFLICT and
//   fails startup closed, because adopting a mismatched winner would install
//   an exposure mapping this process never validated.
// - Schema-admin lane (V02-13): the same reads back the expose/unexpose
//   preflight and post-commit checks. Writes go through the compiled
//   exposure plans in the DDL executor, never through this module.
//
// All statements are fixed and parameterised; this module never constructs
// a pool.

import type pg from "pg"

import { AppError } from "../core/index.js"

import { translatePoolError } from "./pool.js"
import type { ExposedTableMapping } from "./table-registry.js"

export interface ExposureRegistryDependencies {
  query: <R extends pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<R>>
}

/** One exposed table as stored in the durable registry. */
export interface ExposureRegistryEntry {
  readonly alias: string
  readonly schema: string
  readonly table: string
}

/**
 * Full registry state: the initialization guard plus every currently
 * exposed mapping. When initialized is false the registry has never been
 * seeded and the runtime must run the one-time import.
 */
export interface ExposureRegistryState {
  readonly initialized: boolean
  readonly importedAt: Date | null
  readonly exposed: readonly ExposureRegistryEntry[]
}

const STATE_SQL = `
  SELECT initialized, imported_at
  FROM microjbase.exposure_registry_state
  WHERE singleton
`

const EXPOSED_SQL = `
  SELECT alias, schema_name, table_name
  FROM microjbase.exposure_registry
  WHERE exposed
  ORDER BY alias
`

const BY_TARGET_SQL = `
  SELECT alias, schema_name, table_name, exposed
  FROM microjbase.exposure_registry
  WHERE schema_name = $1 AND table_name = $2
`

const BY_ALIAS_SQL = `
  SELECT alias, schema_name, table_name, exposed
  FROM microjbase.exposure_registry
  WHERE alias = $1
`

/** Row as stored, including unexposed history rows. */
export interface ExposureRegistryRow extends ExposureRegistryEntry {
  readonly exposed: boolean
}

interface StateRow {
  initialized: unknown
  imported_at: unknown
}

interface EntryRow {
  alias: unknown
  schema_name: unknown
  table_name: unknown
}

function malformed(reason: string): AppError {
  return new AppError(
    "INTERNAL_ERROR",
    `Malformed exposure registry state: ${reason}`,
    500,
  )
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(`${field} must be a non-empty string`)
  }
  return value
}

async function queryTranslated<R extends pg.QueryResultRow>(
  deps: ExposureRegistryDependencies,
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<R>> {
  try {
    return await deps.query<R>(text, values)
  } catch (error: unknown) {
    throw translatePoolError(error)
  }
}

function mapEntryRow(row: EntryRow): ExposureRegistryEntry {
  return Object.freeze({
    alias: requireNonEmptyString(row.alias, "alias"),
    schema: requireNonEmptyString(row.schema_name, "schema_name"),
    table: requireNonEmptyString(row.table_name, "table_name"),
  })
}

/**
 * Read the singleton guard plus all exposed rows in alias order. A missing
 * state row means migration 0006 was never applied; that surfaces as a
 * translated database error at the composition root (startup fails closed
 * with an operator-facing message instead of silently exposing nothing).
 */
export async function readExposureRegistryState(
  deps: ExposureRegistryDependencies,
): Promise<ExposureRegistryState> {
  const stateResult = await queryTranslated<StateRow>(deps, STATE_SQL)
  const stateRow = stateResult.rows[0]
  if (stateRow === undefined) {
    throw malformed("singleton state row is missing")
  }
  if (typeof stateRow.initialized !== "boolean") {
    throw malformed("initialized must be a boolean")
  }
  if (
    stateRow.imported_at !== null &&
    !(stateRow.imported_at instanceof Date)
  ) {
    throw malformed("imported_at must be a timestamp or null")
  }

  const exposedResult = await queryTranslated<EntryRow>(deps, EXPOSED_SQL)
  return Object.freeze({
    initialized: stateRow.initialized,
    importedAt: stateRow.imported_at,
    exposed: Object.freeze(exposedResult.rows.map(mapEntryRow)),
  })
}

export async function findExposureByTarget(
  deps: ExposureRegistryDependencies,
  schema: string,
  table: string,
): Promise<ExposureRegistryRow | null> {
  const result = await queryTranslated<EntryRow & { exposed: unknown }>(
    deps,
    BY_TARGET_SQL,
    [schema, table],
  )
  const row = result.rows[0]
  if (row === undefined) {
    return null
  }
  if (typeof row.exposed !== "boolean") {
    throw malformed("exposed must be a boolean")
  }
  return Object.freeze({ ...mapEntryRow(row), exposed: row.exposed })
}

export async function findExposureByAlias(
  deps: ExposureRegistryDependencies,
  alias: string,
): Promise<ExposureRegistryRow | null> {
  const result = await queryTranslated<EntryRow & { exposed: unknown }>(
    deps,
    BY_ALIAS_SQL,
    [alias],
  )
  const row = result.rows[0]
  if (row === undefined) {
    return null
  }
  if (typeof row.exposed !== "boolean") {
    throw malformed("exposed must be a boolean")
  }
  return Object.freeze({ ...mapEntryRow(row), exposed: row.exposed })
}

const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/i
const FORBIDDEN_SCHEMAS = new Set([
  "microjbase",
  "pg_catalog",
  "information_schema",
])

// Mirrors the validation inside microjbase.import_exposure_registry so a bad
// MICROJBASE_TABLES value fails at startup with the same stable VALIDATION_ERROR
// shape the v0.1 parser produced, before the audited function is ever called.
function validateMapping(mapping: ExposedTableMapping): void {
  if (!ALIAS_PATTERN.test(mapping.alias)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MICROJBASE_TABLES alias "${mapping.alias}" must match ${ALIAS_PATTERN.source}`,
      400,
      { variable: "MICROJBASE_TABLES" },
    )
  }
  if (!IDENTIFIER_PATTERN.test(mapping.schema)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MICROJBASE_TABLES schema "${mapping.schema}" is not a valid identifier`,
      400,
      { variable: "MICROJBASE_TABLES" },
    )
  }
  if (!IDENTIFIER_PATTERN.test(mapping.table)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MICROJBASE_TABLES table "${mapping.table}" is not a valid identifier`,
      400,
      { variable: "MICROJBASE_TABLES" },
    )
  }
  if (FORBIDDEN_SCHEMAS.has(mapping.schema.toLowerCase())) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MICROJBASE_TABLES schema "${mapping.schema}" cannot be exposed`,
      400,
      { variable: "MICROJBASE_TABLES" },
    )
  }
}

interface ImportPayloadEntry {
  readonly alias: string
  readonly schema: string
  readonly table: string
}

/**
 * Build the validated JSON payload for the one-time import. The payload
 * shape (alias/schema/table keys) is part of the migration 0006 function
 * contract; the SQL function re-validates everything it receives.
 */
export function buildImportPayload(
  mappings: readonly ExposedTableMapping[],
): readonly ImportPayloadEntry[] {
  const seenAliases = new Set<string>()
  const seenTargets = new Set<string>()
  const payload: ImportPayloadEntry[] = []
  for (const mapping of mappings) {
    validateMapping(mapping)
    const target = `${mapping.schema}.${mapping.table}`
    if (seenAliases.has(mapping.alias) || seenTargets.has(target)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "MICROJBASE_TABLES contains duplicate aliases or targets",
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }
    seenAliases.add(mapping.alias)
    seenTargets.add(target)
    payload.push({
      alias: mapping.alias,
      schema: mapping.schema,
      table: mapping.table,
    })
  }
  return payload
}

/**
 * Run the one-time import. The state is read first: an already-initialized
 * registry is a conflict (the composition root gates on the state, so this
 * means an operator or caller mistake). When the import call itself fails,
 * the state is re-read — if a concurrent process initialized the registry
 * first with the same exposed (alias, schema, table) set, its state is
 * returned so startup proceeds once; a winner with a different set means
 * someone else chose a conflicting exposure mapping, so startup fails closed
 * with CONFLICT instead of serving an unvalidated registry; otherwise the
 * translated error fails startup closed.
 */
export async function importInitialExposure(
  deps: ExposureRegistryDependencies,
  mappings: readonly ExposedTableMapping[],
): Promise<ExposureRegistryState> {
  const before = await readExposureRegistryState(deps)
  if (before.initialized) {
    throw new AppError(
      "CONFLICT",
      "Exposure registry is already initialized",
      409,
    )
  }
  const payload = buildImportPayload(mappings)
  try {
    await queryTranslated(
      deps,
      "SELECT microjbase.import_exposure_registry($1::jsonb)",
      [JSON.stringify(payload)],
    )
  } catch (error: unknown) {
    const state = await readExposureRegistryState(deps)
    if (state.initialized && exposedSetsEqual(state.exposed, payload)) {
      return state
    }
    if (state.initialized) {
      throw new AppError(
        "CONFLICT",
        "Exposure registry was initialized concurrently with a different mapping set",
        409,
      )
    }
    throw translatePoolError(error)
  }
  return readExposureRegistryState(deps)
}

function exposedSetsEqual(
  exposed: readonly ExposureRegistryEntry[],
  payload: readonly ImportPayloadEntry[],
): boolean {
  if (exposed.length !== payload.length) {
    return false
  }
  const keys = (entries: readonly ImportPayloadEntry[]): Set<string> =>
    new Set(
      entries.map((entry) => `${entry.alias}${entry.schema}${entry.table}`),
    )
  const exposedKeys = keys(exposed)
  if (exposedKeys.size !== exposed.length) {
    return false
  }
  for (const entry of payload) {
    if (!exposedKeys.has(`${entry.alias}${entry.schema}${entry.table}`)) {
      return false
    }
  }
  return true
}
