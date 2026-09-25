// Typed DDL planner/compiler and transactional executor for microJBase v0.2
// (V02-06), plus the V02-07..V02-09 table/column mutation builders that
// compile on this core.
//
// This is the single audited DDL layer every schema mutation command
// compiles through (D-014). Invariants:
//
// - Identifiers pass conservative validation and are quoted by one helper;
//   values are parameterised where PostgreSQL permits and otherwise come only
//   from typed, strictly validated literal templates.
// - The initial type allowlist is frozen by the plan: text, integer, bigint,
//   boolean, uuid, timestamp, timestamptz, date, numeric, jsonb.
// - Default templates are a typed literal, current_timestamp (only for
//   timestamp/timestamptz), and random_uuid (only for uuid). Arbitrary
//   default SQL has no representation here.
// - Internal schemas (microjbase, pg_catalog, information_schema, pg_*) are
//   refused at the compiler boundary, before any SQL exists, matched
//   case-insensitively.
// - A plan is data (statement list plus a safe description), but it is also
//   sealed: only the compiler functions in this module can produce a plan
//   object execute() will run. Hand-built statement lists are refused before
//   any database connection is touched, and the operation checksum recorded
//   in history covers the sealed statement list as well as the typed command,
//   so a replayed idempotency key cannot smuggle in different SQL.
// - Dry-run executes a sealed plan inside a transaction that always rolls
//   back and never touches durable history.
// - Real execution runs on ONE connection inside ONE transaction: session
//   hardening (standard_conforming_strings=on, pinned search_path), the
//   reserved schema-DDL advisory key 7921890504698152930 (distinct from the
//   migration runner key 7921890504698152929), the history row insert, the
//   statements themselves (each submitted with the extended query protocol so
//   one string cannot chain a second command), and the succeeded update
//   commit or roll back together. A failure therefore never leaves a durable
//   'running' key behind a committed change; lock_timeout / 55P03 and the
//   statement timeout raised while waiting on the advisory key or the
//   idempotency row map to the in-progress 409 so concurrent callers fail
//   closed instead of hanging.
// - PostgreSQL errors are mapped to safe envelopes that never leak database
//   internals; logs carry only event names, command types, and counts.
//
// Later waves add builders (alter/drop, indexes, constraints, policies) on
// top of this compiler core; no mutation command ships until its wave. The
// V02-07..V02-09 builders below (table rename/drop, column add/rename/drop,
// defaults, nullability, matrix-only type changes) are used by the typed
// mutation commands in schema-mutations.ts and never construct SQL outside
// the compiled plan shape.

import type { JsonValue, JsonPrimitive } from "../contracts/index.js"
import { AppError, type ErrorCode } from "../core/index.js"

import type pg from "pg"

import type { Pool } from "./pool.js"
import type {
  SchemaOperationBeginOutcome,
  SchemaOperationLog,
  SchemaOperationRecord,
} from "./schema-operation-log.js"

/**
 * Reserved 64-bit advisory-lock key for schema-DDL serialization, distinct
 * from the migration runner key 7921890504698152929 (D-017).
 */
export const SCHEMA_DDL_LOCK_KEY = 7_921_890_504_698_152_930n

export const MIGRATION_LOCK_KEY_FOR_DISTINCTION = 7_921_890_504_698_152_929n

const TYPE_ALLOWLIST = {
  text: "text",
  integer: "integer",
  bigint: "bigint",
  boolean: "boolean",
  uuid: "uuid",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
  date: "date",
  numeric: "numeric",
  jsonb: "jsonb",
} as const

export type DdlColumnType = keyof typeof TYPE_ALLOWLIST

const INTERNAL_SCHEMA_NAMES = new Set([
  "microjbase",
  "pg_catalog",
  "information_schema",
])

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// Conservative ISO-8601-ish timestamp shape: date, time, optional fractional
// seconds, optional Z or numeric offset. Anything fancier is rejected rather
// than parsed.
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/

const DATE_PARTS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const INT4_MIN = -2_147_483_648
const INT4_MAX = 2_147_483_647

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

// Validates a real calendar date so an impossible literal fails at the
// compiler with VALIDATION_ERROR instead of surfacing as a database error.
function isValidDate(value: string): boolean {
  const match = DATE_PARTS_PATTERN.exec(value)
  if (match === null) {
    return false
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) {
    return false
  }
  const daysInMonth =
    month === 2
      ? isLeapYear(year)
        ? 29
        : 28
      : month === 4 || month === 6 || month === 9 || month === 11
        ? 30
        : 31
  return day <= daysInMonth
}

function invalidIdentifier(): AppError {
  return new AppError("VALIDATION_ERROR", "Invalid SQL identifier", 400)
}

/**
 * Validate a single identifier without quoting it. Callers that build their
 * own SQL (e.g. preflight reads in schema-mutations.ts) use this to reject
 * hostile names with the same stable error the compiler raises.
 */
export function assertDdlIdentifier(name: string): void {
  if (!SIMPLE_IDENTIFIER.test(name)) {
    throw invalidIdentifier()
  }
}

function invalidInput(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, 400)
}

function quoteIdentifier(name: string): string {
  if (!SIMPLE_IDENTIFIER.test(name)) {
    throw invalidIdentifier()
  }
  return `"${name.replace(/"/g, '""')}"`
}

// SQL literal quoting for the typed literal default template. PostgreSQL does
// not accept parameters in DDL DEFAULT clauses, so literal defaults are
// rendered through this audited helper after strict per-type validation; the
// input shapes below can never break out of the literal. NUL and backslash
// are refused outright: every admin transaction pins
// standard_conforming_strings=on before any statement runs, and rejecting the
// escape character outright removes the one path that could close a literal
// early on a misconfigured session.
function quoteLiteral(value: string): string {
  if (value.includes("\0")) {
    throw invalidInput("literal defaults must not contain NUL characters")
  }
  if (value.includes("\\")) {
    throw invalidInput("literal defaults must not contain backslash characters")
  }
  return `'${value.replace(/'/g, "''")}'`
}

// Internal schemas are matched case-insensitively: unquoted PostgreSQL
// identifiers fold to lowercase, so a lookalike such as PG_catalog or
// MICROJBASE is the same catalog the denylist names.
function assertManageableSchema(schema: string): void {
  const normalized = schema.toLowerCase()
  if (INTERNAL_SCHEMA_NAMES.has(normalized) || normalized.startsWith("pg_")) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Internal schemas cannot be modified",
      400,
    )
  }
}

export type DdlColumnDefault =
  | { readonly kind: "none" }
  | { readonly kind: "literal"; readonly value: JsonPrimitive }
  | { readonly kind: "current_timestamp" }
  | { readonly kind: "random_uuid" }

export interface DdlColumnSpec {
  readonly name: string
  readonly type: DdlColumnType
  readonly nullable: boolean
  readonly default: DdlColumnDefault
  /**
   * Emit this column as a PRIMARY KEY column constraint. Only the managed
   * table-lifecycle command uses this (V02-07); the generic V02-06 builder
   * callers leave it unset.
   */
  readonly primaryKey?: boolean
}

export interface CreateTableSpec {
  readonly schema: string
  readonly table: string
  readonly columns: readonly DdlColumnSpec[]
}

export interface DdlPlan {
  /** Ordered SQL statements; each comes only from a typed builder. */
  readonly statements: readonly string[]
  /** Human-safe one-line summary for dry-run display; no raw values. */
  readonly description: string
}

// Runtime seal for compiled plans. Only the compiler functions in this
// module add plans to the set, and execute() refuses to run anything that is
// not sealed. A WeakSet keyed by object identity cannot be forged from JSON
// or reconstructed by a caller, and it frees plans for garbage collection.
const SEALED_PLANS = new WeakSet<object>()

function sealPlan(plan: DdlPlan): DdlPlan {
  Object.freeze(plan.statements)
  Object.freeze(plan)
  SEALED_PLANS.add(plan)
  return plan
}

function assertPlanSealed(plan: DdlPlan): void {
  if (!SEALED_PLANS.has(plan)) {
    throw invalidInput(
      "DDL plans must be compiled by the typed schema DDL compiler",
    )
  }
}

// Expands the shortest round-trip decimal rendering of a double (which uses
// exponent notation outside [1e-6, 1e21)) into plain decimal notation, so
// numeric defaults are always rendered as unambiguous SQL numeric literals.
function expandExponential(rendered: string): string {
  const [mantissaRaw, exponentRaw] = rendered.split("e")
  const mantissa = mantissaRaw ?? ""
  const exponent = Number(exponentRaw ?? "0")
  const negative = mantissa.startsWith("-")
  const unsigned = negative ? mantissa.slice(1) : mantissa
  const dotIndex = unsigned.indexOf(".")
  const integerDigits = dotIndex === -1 ? unsigned.length : dotIndex
  const digits = unsigned.replace(".", "")
  const pointAt = integerDigits + exponent
  let plain: string
  if (pointAt <= 0) {
    plain = `0.${"0".repeat(-pointAt)}${digits}`
  } else if (pointAt >= digits.length) {
    plain = `${digits}${"0".repeat(pointAt - digits.length)}`
  } else {
    plain = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`
  }
  return negative ? `-${plain}` : plain
}

function renderNumericDefault(value: number): string {
  if (Number.isSafeInteger(value)) {
    return String(value)
  }
  const rendered = String(value)
  if (!/[eE]/.test(rendered)) {
    return rendered
  }
  return expandExponential(rendered)
}

function renderLiteralDefault(
  type: DdlColumnType,
  value: JsonPrimitive,
): string {
  switch (type) {
    case "text": {
      if (typeof value !== "string") {
        throw invalidInput("text literal defaults must be strings")
      }
      return `${quoteLiteral(value)}::text`
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw invalidInput("integer literal defaults must be whole numbers")
      }
      if (
        !Number.isSafeInteger(value) ||
        value < INT4_MIN ||
        value > INT4_MAX
      ) {
        throw invalidInput("integer literal defaults must fit the int4 range")
      }
      return String(value)
    }
    case "bigint": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw invalidInput("bigint literal defaults must be whole numbers")
      }
      // Every safe integer already fits int8; anything larger is not exactly
      // representable as a JavaScript number and is refused.
      if (!Number.isSafeInteger(value)) {
        throw invalidInput("bigint literal defaults must fit the int8 range")
      }
      return String(value)
    }
    case "numeric": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidInput("numeric literal defaults must be finite numbers")
      }
      return renderNumericDefault(value)
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw invalidInput("boolean literal defaults must be true or false")
      }
      return value ? "TRUE" : "FALSE"
    }
    case "uuid": {
      if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        throw invalidInput("uuid literal defaults must be UUID strings")
      }
      return `${quoteLiteral(value.toLowerCase())}::uuid`
    }
    case "date": {
      if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
        throw invalidInput("date literal defaults must be YYYY-MM-DD strings")
      }
      if (!isValidDate(value)) {
        throw invalidInput("date literal defaults must be real calendar dates")
      }
      return `${quoteLiteral(value)}::date`
    }
    case "timestamp":
    case "timestamptz": {
      if (
        typeof value !== "string" ||
        !TIMESTAMP_PATTERN.test(value) ||
        !isValidDate(value.slice(0, 10))
      ) {
        throw invalidInput(
          "timestamp literal defaults must be ISO-8601 timestamp strings",
        )
      }
      const cast = type === "timestamptz" ? "timestamptz" : "timestamp"
      return `${quoteLiteral(value)}::${cast}`
    }
    case "jsonb": {
      if (value === null) {
        return "NULL::jsonb"
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw invalidInput("jsonb literal defaults must be JSON values")
      }
      const rendered = JSON.stringify(value)
      if (rendered === undefined) {
        throw invalidInput("jsonb literal defaults must be JSON values")
      }
      return `${quoteLiteral(rendered)}::jsonb`
    }
  }
}

function renderDefaultClause(
  type: DdlColumnType,
  columnDefault: DdlColumnDefault,
): string {
  switch (columnDefault.kind) {
    case "none":
      return ""
    case "literal":
      return ` DEFAULT ${renderLiteralDefault(type, columnDefault.value)}`
    case "current_timestamp":
      if (type !== "timestamp" && type !== "timestamptz") {
        throw invalidInput(
          "current_timestamp defaults are only allowed for timestamp and timestamptz columns",
        )
      }
      return " DEFAULT CURRENT_TIMESTAMP"
    case "random_uuid":
      if (type !== "uuid") {
        throw invalidInput(
          "random_uuid defaults are only allowed for uuid columns",
        )
      }
      return " DEFAULT pg_catalog.gen_random_uuid()"
  }
}

/**
 * Compile the initial supported DDL statement: CREATE TABLE over the frozen
 * type allowlist and default templates. Later waves build additional typed
 * builders on this core; there is deliberately no generic SQL path.
 */
export function compileCreateTable(spec: CreateTableSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  if (spec.columns.length === 0) {
    throw invalidInput("a table needs at least one column")
  }

  const renderedColumns: string[] = []
  const seenNames = new Set<string>()
  for (const column of spec.columns) {
    if (!Object.hasOwn(TYPE_ALLOWLIST, column.type)) {
      throw invalidInput(`column type "${column.type}" is not allowlisted`)
    }
    if (seenNames.has(column.name)) {
      throw invalidInput(`duplicate column name "${column.name}"`)
    }
    seenNames.add(column.name)

    const renderedType = TYPE_ALLOWLIST[column.type]
    const nullability = column.nullable ? "" : " NOT NULL"
    const defaultClause = renderDefaultClause(column.type, column.default)
    const primaryKey = column.primaryKey === true ? " PRIMARY KEY" : ""
    renderedColumns.push(
      `${quoteIdentifier(column.name)} ${renderedType}${nullability}${defaultClause}${primaryKey}`,
    )
  }

  const statement = `CREATE TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} (\n  ${renderedColumns.join(",\n  ")}\n)`
  return sealPlan({
    statements: [statement],
    description: `create table ${spec.schema}.${spec.table} with ${String(spec.columns.length)} column(s)`,
  })
}

export function describePlan(plan: DdlPlan): readonly string[] {
  return plan.statements
}

// ---------------------------------------------------------------------------
// V02-07..V02-09 typed builders. Every statement below carries exactly one
// command and reaches PostgreSQL only through the extended query protocol in
// the executor, so no string can chain a second statement. Identifiers pass
// the same conservative validation and quoting helper as the V02-06 core.
// ---------------------------------------------------------------------------

export interface RenameTableSpec {
  readonly schema: string
  readonly table: string
  readonly newName: string
}

export interface DropTableSpec {
  readonly schema: string
  readonly table: string
}

export interface AddColumnSpec {
  readonly schema: string
  readonly table: string
  readonly column: DdlColumnSpec
}

export interface RenameColumnSpec {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly newName: string
}

export interface DropColumnSpec {
  readonly schema: string
  readonly table: string
  readonly column: string
}

export interface ColumnDefaultSpec {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly type: DdlColumnType
  readonly default: DdlColumnDefault
}

export interface ColumnTargetSpec {
  readonly schema: string
  readonly table: string
  readonly column: string
}

/**
 * The frozen safe type-conversion matrix (V02-09). A conversion compiles only
 * when the pair appears here; there is deliberately no arbitrary `USING`
 * path. Every entry is a widening PostgreSQL can apply without a USING
 * clause and without data loss for any value of the source type:
 *
 * - integer -> bigint, integer -> numeric, bigint -> numeric (widening)
 * - date -> timestamp (midnight extension, no timezone involved)
 *
 * Everything else — including anything touching timestamp with time zone,
 * uuid, jsonb, boolean, or text — is refused at the compiler, before SQL
 * exists.
 */
export const SAFE_TYPE_CONVERSIONS: Readonly<
  Record<DdlColumnType, readonly DdlColumnType[]>
> = Object.freeze({
  text: [],
  integer: Object.freeze(["bigint", "numeric"] as const),
  bigint: Object.freeze(["numeric"] as const),
  boolean: [],
  uuid: [],
  timestamp: [],
  timestamptz: [],
  date: Object.freeze(["timestamp"] as const),
  numeric: [],
  jsonb: [],
})

export interface ChangeColumnTypeSpec {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly fromType: DdlColumnType
  readonly toType: DdlColumnType
}

export function compileRenameTable(spec: RenameTableSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const statement = `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} RENAME TO ${quoteIdentifier(spec.newName)}`
  return sealPlan({
    statements: [statement],
    description: `rename table ${spec.schema}.${spec.table} to ${spec.newName}`,
  })
}

export function compileDropTable(spec: DropTableSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const statement = `DROP TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)}`
  return sealPlan({
    statements: [statement],
    description: `drop table ${spec.schema}.${spec.table}`,
  })
}

export function compileAddColumn(spec: AddColumnSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  if (!Object.hasOwn(TYPE_ALLOWLIST, spec.column.type)) {
    throw invalidInput(`column type "${spec.column.type}" is not allowlisted`)
  }
  const renderedType = TYPE_ALLOWLIST[spec.column.type]
  const nullability = spec.column.nullable ? "" : " NOT NULL"
  const defaultClause = renderDefaultClause(
    spec.column.type,
    spec.column.default,
  )
  const primaryKey = spec.column.primaryKey === true ? " PRIMARY KEY" : ""
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `ADD COLUMN ${quoteIdentifier(spec.column.name)} ${renderedType}${nullability}${defaultClause}${primaryKey}`
  return sealPlan({
    statements: [statement],
    description: `add column ${spec.column.name} to ${spec.schema}.${spec.table}`,
  })
}

export function compileRenameColumn(spec: RenameColumnSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `RENAME COLUMN ${quoteIdentifier(spec.column)} TO ${quoteIdentifier(spec.newName)}`
  return sealPlan({
    statements: [statement],
    description: `rename column ${spec.column} on ${spec.schema}.${spec.table} to ${spec.newName}`,
  })
}

export function compileDropColumn(spec: DropColumnSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `DROP COLUMN ${quoteIdentifier(spec.column)}`
  return sealPlan({
    statements: [statement],
    description: `drop column ${spec.column} from ${spec.schema}.${spec.table}`,
  })
}

export function compileSetColumnDefault(spec: ColumnDefaultSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const defaultClause = renderDefaultClause(spec.type, spec.default)
  if (defaultClause === "") {
    throw invalidInput("a default value is required to set a column default")
  }
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `ALTER COLUMN ${quoteIdentifier(spec.column)} SET${defaultClause}`
  return sealPlan({
    statements: [statement],
    description: `set the default of column ${spec.column} on ${spec.schema}.${spec.table}`,
  })
}

export function compileDropColumnDefault(spec: ColumnTargetSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `ALTER COLUMN ${quoteIdentifier(spec.column)} DROP DEFAULT`
  return sealPlan({
    statements: [statement],
    description: `drop the default of column ${spec.column} on ${spec.schema}.${spec.table}`,
  })
}

export function compileSetNotNull(spec: ColumnTargetSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `ALTER COLUMN ${quoteIdentifier(spec.column)} SET NOT NULL`
  return sealPlan({
    statements: [statement],
    description: `set column ${spec.column} on ${spec.schema}.${spec.table} NOT NULL`,
  })
}

export function compileDropNotNull(spec: ColumnTargetSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `ALTER COLUMN ${quoteIdentifier(spec.column)} DROP NOT NULL`
  return sealPlan({
    statements: [statement],
    description: `drop the NOT NULL constraint of column ${spec.column} on ${spec.schema}.${spec.table}`,
  })
}

export function compileChangeColumnType(spec: ChangeColumnTypeSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  const allowedTargets = SAFE_TYPE_CONVERSIONS[spec.fromType] ?? []
  if (!allowedTargets.includes(spec.toType)) {
    throw invalidInput(
      `type conversion from ${spec.fromType} to ${spec.toType} is not in the safe conversion matrix`,
    )
  }
  const targetSqlType = TYPE_ALLOWLIST[spec.toType]
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `ALTER COLUMN ${quoteIdentifier(spec.column)} TYPE ${targetSqlType}`
  return sealPlan({
    statements: [statement],
    description: `change the type of column ${spec.column} on ${spec.schema}.${spec.table} from ${spec.fromType} to ${spec.toType}`,
  })
}

export interface ExecuteOptions {
  readonly idempotencyKey: string
  readonly commandType: string
  readonly command: JsonValue
  readonly actor: string
  /** Execute everything, then roll back; no durable history is written. */
  readonly dryRun?: boolean
}

export interface ExecuteOutcome {
  readonly dryRun: boolean
  /** True when a recorded success was replayed without re-executing. */
  readonly replayed: boolean
  readonly record: SchemaOperationRecord | null
}

// The query capability the executor hands to the operation log for the
// duration of one transaction; it is bound to the executor's own client so
// the history row and the DDL commit or roll back together.
export type SchemaOperationLogQuery = (
  text: string,
  values?: unknown[],
) => Promise<pg.QueryResult>

export interface SchemaDdlExecutorDependencies {
  pool: Pool
  createOperationLog: (query: SchemaOperationLogQuery) => SchemaOperationLog
  logger?: Pick<Console, "error" | "warn" | "info" | "debug">
}

// PostgreSQL SQLSTATE codes the executor maps to safe envelopes. Anything
// unmapped becomes INTERNAL_ERROR with no database detail.
const DDL_ERROR_MAP: Record<
  string,
  { code: ErrorCode; message: string; status: number }
> = {
  "42P07": {
    code: "CONFLICT",
    message: "Relation already exists",
    status: 409,
  },
  "42P01": {
    code: "TABLE_NOT_FOUND",
    message: "Referenced table does not exist",
    status: 404,
  },
  "3F000": {
    code: "TABLE_NOT_FOUND",
    message: "Referenced schema does not exist",
    status: 404,
  },
  "23505": {
    code: "CONFLICT",
    message: "Operation conflicts with existing data",
    status: 409,
  },
  "42501": {
    code: "INTERNAL_ERROR",
    message: "Insufficient database privilege for the schema-admin role",
    status: 500,
  },
  "40P01": {
    code: "INTERNAL_ERROR",
    message: "Operation conflicted with a concurrent operation",
    status: 500,
  },
}

export function translateDdlError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error
  }
  const sqlState =
    typeof error === "object" && error !== null
      ? ((error as Record<string, unknown>)["code"] as string | undefined)
      : undefined
  if (typeof sqlState === "string" && Object.hasOwn(DDL_ERROR_MAP, sqlState)) {
    const mapped = DDL_ERROR_MAP[sqlState] as {
      code: ErrorCode
      message: string
      status: number
    }
    return new AppError(mapped.code, mapped.message, mapped.status)
  }
  return new AppError("INTERNAL_ERROR", "Schema operation failed", 500)
}

// First statement of every admin transaction: pin the session to the safe
// literal semantics and catalogue-only name resolution before any SQL from
// the plan (or the operation log) is parsed, so a role- or database-level
// standard_conforming_strings=off or a hostile search_path cannot change how
// the statements are interpreted.
const ADMIN_TRANSACTION_HARDENING_SQL =
  "SELECT set_config('standard_conforming_strings', 'on', true), " +
  "set_config('search_path', 'pg_catalog', true)"

// Errors raised while waiting on the advisory key or the idempotency row mean
// another caller holds the operation; fail closed with the in-progress
// conflict instead of surfacing a timeout or hanging past the pool timeout.
const CONCURRENT_WAIT_SQLSTATES = new Set(["55P03", "57014"])
const DRIVER_QUERY_TIMEOUT_MESSAGE = "Query read timeout"

export interface SchemaDdlExecutor {
  execute(
    plan: DdlPlan | readonly DdlPlan[],
    options: ExecuteOptions,
  ): Promise<ExecuteOutcome>
}

type BeginResult =
  | {
      readonly kind: "accepted"
      readonly operationLog: SchemaOperationLog
      readonly record: SchemaOperationRecord
    }
  | { readonly kind: "replay"; readonly record: SchemaOperationRecord }
  | { readonly kind: "in_progress"; readonly record: SchemaOperationRecord }

function toConcurrentWaitConflict(
  error: unknown,
  idempotencyKey: string,
): AppError | null {
  if (error instanceof AppError) {
    return null
  }
  const sqlState =
    typeof error === "object" && error !== null
      ? ((error as Record<string, unknown>)["code"] as string | undefined)
      : undefined
  const driverTimeout =
    error instanceof Error && error.message === DRIVER_QUERY_TIMEOUT_MESSAGE
  if (
    driverTimeout ||
    (typeof sqlState === "string" && CONCURRENT_WAIT_SQLSTATES.has(sqlState))
  ) {
    return new AppError(
      "CONFLICT",
      "An identical operation is already in progress",
      409,
      { idempotencyKey },
    )
  }
  return null
}

function translateConcurrentWaitError(
  error: unknown,
  idempotencyKey: string,
): AppError {
  if (error instanceof AppError) {
    return error
  }
  return (
    toConcurrentWaitConflict(error, idempotencyKey) ?? translateDdlError(error)
  )
}

async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => {
    // Best-effort rollback; the original error is what matters.
  })
}

// The extended query protocol rejects a statement string that carries more
// than one command, so even a malformed compiled statement cannot chain a
// second command. @types/pg does not model queryMode yet, hence the local
// assertion; the pg runtime has supported it for years.
interface ExtendedQueryConfig {
  readonly text: string
  readonly queryMode: "extended"
}

async function runPlanStatement(
  client: pg.PoolClient,
  statement: string,
): Promise<void> {
  const config = {
    text: statement,
    queryMode: "extended",
  } as pg.QueryConfig & ExtendedQueryConfig
  await client.query(config)
}

export function createSchemaDdlExecutor(
  deps: SchemaDdlExecutorDependencies,
): SchemaDdlExecutor {
  const statementsOf = (
    plan: DdlPlan | readonly DdlPlan[],
  ): readonly string[] => {
    const plans: readonly DdlPlan[] =
      "statements" in plan ? [plan as DdlPlan] : plan
    if (plans.length === 0) {
      throw invalidInput("a DDL execution needs at least one plan")
    }
    const statements: string[] = []
    for (const candidate of plans) {
      assertPlanSealed(candidate)
      if (candidate.statements.length === 0) {
        throw invalidInput("a compiled DDL plan has no statements")
      }
      statements.push(...candidate.statements)
    }
    return statements
  }

  return {
    async execute(
      plan: DdlPlan | readonly DdlPlan[],
      options: ExecuteOptions,
    ): Promise<ExecuteOutcome> {
      const statements = statementsOf(plan)

      if (options.dryRun === true) {
        const client = await deps.pool.connect()
        try {
          await client.query("BEGIN")
          try {
            await client.query(ADMIN_TRANSACTION_HARDENING_SQL)
            await client.query("SELECT pg_advisory_xact_lock($1)", [
              BigInt.asIntN(64, SCHEMA_DDL_LOCK_KEY),
            ])
            for (const statement of statements) {
              await runPlanStatement(client, statement)
            }
          } finally {
            // A dry run never commits: the schema state must be identical
            // after the call, and no history row may appear.
            await client.query("ROLLBACK")
          }
        } catch (error: unknown) {
          throw translateDdlError(error)
        } finally {
          client.release()
        }
        deps.logger?.info(
          JSON.stringify({
            level: "info",
            event: "schema_ddl_dry_run",
            commandType: options.commandType,
            statementCount: statements.length,
          }),
        )
        return { dryRun: true, replayed: false, record: null }
      }

      const client = await deps.pool.connect()
      try {
        await client.query("BEGIN")

        // Idempotency phase: hardening, advisory serialization, and the
        // history-row insert all share the DDL transaction, so the row and
        // the schema change commit or roll back together and a crash can
        // never leave a 'running' key behind a committed change.
        let begun: BeginResult
        try {
          await client.query(ADMIN_TRANSACTION_HARDENING_SQL)
          await client.query("SELECT pg_advisory_xact_lock($1)", [
            BigInt.asIntN(64, SCHEMA_DDL_LOCK_KEY),
          ])
          const operationLog = deps.createOperationLog(async (text, values) => {
            try {
              return await client.query(text, values)
            } catch (error: unknown) {
              // Timeouts raised while waiting on the idempotency row are
              // converted here, while the raw error is still available: the
              // operation log translates raw driver errors into safe
              // envelopes, and AppErrors pass through that translation
              // unchanged.
              const waitConflict = toConcurrentWaitConflict(
                error,
                options.idempotencyKey,
              )
              throw waitConflict ?? error
            }
          })
          const outcome: SchemaOperationBeginOutcome = await operationLog.begin(
            {
              idempotencyKey: options.idempotencyKey,
              commandType: options.commandType,
              command: options.command,
              actor: options.actor,
              statements,
            },
          )
          begun =
            outcome.kind === "accepted"
              ? {
                  kind: "accepted",
                  operationLog,
                  record: outcome.record,
                }
              : outcome
        } catch (error: unknown) {
          await rollbackQuietly(client)
          throw translateConcurrentWaitError(error, options.idempotencyKey)
        }

        if (begun.kind === "replay") {
          await rollbackQuietly(client)
          deps.logger?.info(
            JSON.stringify({
              level: "info",
              event: "schema_ddl_replay",
              commandType: options.commandType,
            }),
          )
          return { dryRun: false, replayed: true, record: begun.record }
        }
        if (begun.kind === "in_progress") {
          await rollbackQuietly(client)
          throw new AppError(
            "CONFLICT",
            "An identical operation is already in progress",
            409,
            { idempotencyKey: options.idempotencyKey },
          )
        }

        try {
          for (const statement of statements) {
            await runPlanStatement(client, statement)
          }
          const record = await begun.operationLog.succeed(begun.record.id, {
            statementCount: statements.length,
          })
          await client.query("COMMIT")
          deps.logger?.info(
            JSON.stringify({
              level: "info",
              event: "schema_ddl_executed",
              commandType: options.commandType,
              statementCount: statements.length,
            }),
          )
          return { dryRun: false, replayed: false, record }
        } catch (error: unknown) {
          await rollbackQuietly(client)
          const safeError = translateDdlError(error)
          deps.logger?.warn(
            JSON.stringify({
              level: "warn",
              event: "schema_ddl_failed",
              commandType: options.commandType,
              errorCode: safeError.code,
            }),
          )
          throw safeError
        }
      } finally {
        client.release()
      }
    },
  }
}
