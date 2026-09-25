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

import { createHash } from "node:crypto"

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

export function isDdlColumnType(value: unknown): value is DdlColumnType {
  return typeof value === "string" && Object.hasOwn(TYPE_ALLOWLIST, value)
}

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

// How format_type(atttypid, atttypmod) renders each allowlisted type, so the
// locked re-check below compares against the same rendering the catalogue
// reader (and therefore the compiler's fromType) is derived from.
const CATALOGUE_TYPE_RENDERINGS: Readonly<Record<DdlColumnType, string>> =
  Object.freeze({
    text: "text",
    integer: "integer",
    bigint: "bigint",
    boolean: "boolean",
    uuid: "uuid",
    timestamp: "timestamp without time zone",
    timestamptz: "timestamp with time zone",
    date: "date",
    numeric: "numeric",
    jsonb: "jsonb",
  })

// SQLSTATE raised by the locked type re-check when the catalogue type inside
// the advisory-locked transaction no longer matches the compiled fromType.
// Class 9C is application-defined, and DDL_ERROR_MAP translates it to the
// in-progress-style conflict so a stale compilation fails closed.
export const STALE_SOURCE_TYPE_SQLSTATE = "9C001"

// SQLSTATE raised by the locked exposure guard compiled into the first
// statement of every structural mutation, RLS disablement, and cascading
// foreign-key plan: the durable exposure registry lists the target as
// exposed, so the command must fail closed inside the advisory lock instead
// of trusting the in-memory registry the preflight read earlier (JDW-27).
export const EXPOSED_MUTATION_GUARD_SQLSTATE = "9C003"

// SQLSTATE raised by the locked exposure-prerequisite guard compiled into
// every expose plan: the target is already exposed, or row security is no
// longer enabled and forced, or no policy applies to the runtime role. The
// whole exposure transaction rolls back, so an expose can never commit
// against drifted RLS state or rename the public alias of an exposed table.
export const EXPOSURE_GUARD_SQLSTATE = "9C004"

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
  const assertion = compileLockedSourceTypeAssertion(spec)
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `ALTER COLUMN ${quoteIdentifier(spec.column)} TYPE ${targetSqlType}`
  return sealPlan({
    statements: [assertion, statement],
    description: `change the type of column ${spec.column} on ${spec.schema}.${spec.table} from ${spec.fromType} to ${spec.toType}`,
  })
}

// The safe-conversion matrix is applied at compile time, outside the advisory
// lock; a concurrent type change committed between compilation and execution
// would otherwise slip past the matrix (PostgreSQL happily "converts"
// numeric->bigint or timestamptz->timestamp, rounding or dropping data). The
// executor runs this assertion as the first statement of the plan, inside the
// same transaction and after the same advisory key as the ALTER TYPE, and it
// re-reads the catalogue type under that lock. Any drift from the compiled
// fromType raises STALE_SOURCE_TYPE_SQLSTATE and the whole transaction rolls
// back, so the matrix can never be applied to a column the compiler never
// inspected. Identifiers and the expected rendering are strictly validated
// before they are embedded, and the body carries no caller input beyond them.
function compileLockedSourceTypeAssertion(spec: ChangeColumnTypeSpec): string {
  const expectedRendering = CATALOGUE_TYPE_RENDERINGS[spec.fromType]
  return `DO $microjbase$
DECLARE
  microjbase_actual_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO microjbase_actual_type
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ${quoteLiteral(spec.schema)}
    AND c.relname = ${quoteLiteral(spec.table)}
    AND a.attname = ${quoteLiteral(spec.column)}
    AND a.attnum > 0
    AND NOT a.attisdropped;
  IF microjbase_actual_type IS DISTINCT FROM ${quoteLiteral(expectedRendering)} THEN
    RAISE EXCEPTION 'compiled source type no longer matches the column'
      USING ERRCODE = '${STALE_SOURCE_TYPE_SQLSTATE}';
  END IF;
END
$microjbase$`
}

// ---------------------------------------------------------------------------
// V02-11..V02-13 typed builders: indexes, unique constraints, foreign keys,
// and the runtime privilege/registry statements the exposure service
// compiles. The same invariants apply: identifiers pass conservative
// validation and one quoting helper, values are parameterised where
// PostgreSQL permits and otherwise come from strictly validated literals,
// internal schemas are refused before SQL exists, and every statement
// carries exactly one command.
// ---------------------------------------------------------------------------

// PostgreSQL folds or truncates identifiers beyond 63 bytes; names that
// long are refused rather than silently renamed. All accepted names are
// ASCII (the identifier pattern), so character length equals byte length.
const MAX_IDENTIFIER_LENGTH = 63

function assertDdlName(name: string, context: string): void {
  assertDdlIdentifier(name)
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw invalidInput(`${context} must be at most 63 characters`)
  }
}

// Module-created objects carry an mjb_ prefix so operators can tell managed
// objects from pre-existing ones in the catalogue, and so later removal
// commands can refuse to touch objects they did not create. Deterministic
// names derive only from the validated table and column identifiers, so the
// same command always compiles the same name; a short digest of the full
// identity (table, columns, kind) is always appended, because validated
// identifiers may themselves contain underscores — ["a_b","c"] and
// ["a","b_c"] would otherwise both compile to mjb_t_a_b_c_<kind> (R5 review,
// JDW-23). Overlong bases are truncated with the digest retained instead of
// PostgreSQL's silent truncation. The preflight guards reuse this helper so
// the existence probe and the compiled statement can never drift apart.
const MAX_KEY_COLUMNS = 16

export function deterministicObjectName(
  kind: "idx" | "uniq" | "fkey" | OwnershipPolicyTemplate,
  table: string,
  columns: readonly string[],
): string {
  // NUL separators: validated identifiers can never contain one, so the
  // digest input is unambiguous even when column names concatenate to the
  // same string.
  const digest = createHash("sha256")
    .update(`${table}\u0000${columns.join("\u0000")}\u0000${kind}`, "utf8")
    .digest("hex")
    .slice(0, hashPrefixLength)
  const readable = `mjb_${table}_${columns.join("_")}_${kind}`
  if (readable.length + digest.length + 1 <= MAX_IDENTIFIER_LENGTH) {
    return `${readable}_${digest}`
  }
  const headLength = MAX_IDENTIFIER_LENGTH - digest.length - 1
  return `${readable.slice(0, headLength)}_${digest}`
}

const hashPrefixLength = 8

function assertKeyColumns(columns: readonly string[], context: string): void {
  if (columns.length === 0) {
    throw invalidInput(`${context} needs at least one column`)
  }
  if (columns.length > MAX_KEY_COLUMNS) {
    throw invalidInput(
      `${context} must have at most ${String(MAX_KEY_COLUMNS)} columns`,
    )
  }
  const seen = new Set<string>()
  for (const column of columns) {
    assertDdlIdentifier(column)
    if (seen.has(column)) {
      throw invalidInput(`${context} lists column "${column}" more than once`)
    }
    seen.add(column)
  }
}

function quoteColumnList(columns: readonly string[]): string {
  return `(${columns.map((column) => quoteIdentifier(column)).join(", ")})`
}

export interface CreateIndexSpec {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
  /** Explicit name; validated, otherwise a deterministic name is derived. */
  readonly name?: string
}

export function compileCreateIndex(spec: CreateIndexSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  assertKeyColumns(spec.columns, "an index")
  const name =
    spec.name ?? deterministicObjectName("idx", spec.table, spec.columns)
  assertDdlName(name, "index name")
  const statement =
    `CREATE INDEX ${quoteIdentifier(name)} ` +
    `ON ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ${quoteColumnList(spec.columns)}`
  return sealPlan({
    statements: [statement],
    description: `create index ${name} on ${spec.schema}.${spec.table}`,
  })
}

export interface DropIndexSpec {
  readonly schema: string
  /** Index name; indexes are schema children, not table children. */
  readonly name: string
}

export function compileDropIndex(spec: DropIndexSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlName(spec.name, "index name")
  const statement = `DROP INDEX ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.name)}`
  return sealPlan({
    statements: [statement],
    description: `drop index ${spec.schema}.${spec.name}`,
  })
}

export interface AddUniqueConstraintSpec {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
  /** Explicit name; validated, otherwise a deterministic name is derived. */
  readonly name?: string
}

export function compileAddUniqueConstraint(
  spec: AddUniqueConstraintSpec,
): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  assertKeyColumns(spec.columns, "a unique constraint")
  const name =
    spec.name ?? deterministicObjectName("uniq", spec.table, spec.columns)
  assertDdlName(name, "constraint name")
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `ADD CONSTRAINT ${quoteIdentifier(name)} UNIQUE ${quoteColumnList(spec.columns)}`
  return sealPlan({
    statements: [statement],
    description: `add unique constraint ${name} on ${spec.schema}.${spec.table}`,
  })
}

export interface DropConstraintSpec {
  readonly schema: string
  readonly table: string
  readonly name: string
}

export function compileDropConstraint(spec: DropConstraintSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  assertDdlName(spec.name, "constraint name")
  const statement =
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
    `DROP CONSTRAINT ${quoteIdentifier(spec.name)}`
  return sealPlan({
    statements: [statement],
    description: `drop constraint ${spec.name} on ${spec.schema}.${spec.table}`,
  })
}

/**
 * The frozen foreign-key action allowlist (V02-12). SET DEFAULT is
 * deliberately excluded; set_null is compiled only when the service has
 * verified every referencing column is nullable.
 */
export type ForeignKeyAction = "no_action" | "restrict" | "cascade" | "set_null"

const FOREIGN_KEY_ACTION_SQL: Readonly<Record<ForeignKeyAction, string>> =
  Object.freeze({
    no_action: "NO ACTION",
    restrict: "RESTRICT",
    cascade: "CASCADE",
    set_null: "SET NULL",
  })

export interface ForeignKeyReferenceSpec {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
}

export interface AddForeignKeySpec {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
  readonly references: ForeignKeyReferenceSpec
  readonly onUpdate: ForeignKeyAction
  readonly onDelete: ForeignKeyAction
  /** Explicit name; validated, otherwise a deterministic name is derived. */
  readonly name?: string
}

export function compileAddForeignKey(spec: AddForeignKeySpec): DdlPlan {
  assertManageableSchema(spec.schema)
  assertManageableSchema(spec.references.schema)
  assertDdlIdentifier(spec.table)
  assertDdlIdentifier(spec.references.table)
  assertKeyColumns(spec.columns, "a foreign key")
  assertKeyColumns(spec.references.columns, "a foreign key target")
  if (spec.columns.length !== spec.references.columns.length) {
    throw invalidInput(
      "a foreign key must reference the same number of columns it constrains",
    )
  }
  if (!Object.hasOwn(FOREIGN_KEY_ACTION_SQL, spec.onUpdate)) {
    throw invalidInput(`onUpdate action "${spec.onUpdate}" is not allowlisted`)
  }
  if (!Object.hasOwn(FOREIGN_KEY_ACTION_SQL, spec.onDelete)) {
    throw invalidInput(`onDelete action "${spec.onDelete}" is not allowlisted`)
  }
  const name =
    spec.name ?? deterministicObjectName("fkey", spec.table, spec.columns)
  assertDdlName(name, "constraint name")
  // A cascading or nullifying referential action rewrites rows in the
  // referencing table without consulting its row-security policies (the
  // action fires as the table owner), so it can delete or null another
  // tenant's rows even under FORCE RLS. Refuse the action inside the same
  // advisory lock when either end of the key is exposed; unexposed tables
  // keep the frozen action allowlist (JDW-27).
  const statements: string[] = []
  if (
    spec.onUpdate === "cascade" ||
    spec.onUpdate === "set_null" ||
    spec.onDelete === "cascade" ||
    spec.onDelete === "set_null"
  ) {
    statements.push(
      exposedGuardStatement(spec.schema, spec.table),
      exposedGuardStatement(spec.references.schema, spec.references.table),
    )
  }
  statements.push(
    `ALTER TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} ` +
      `ADD CONSTRAINT ${quoteIdentifier(name)} FOREIGN KEY ${quoteColumnList(spec.columns)} ` +
      `REFERENCES ${quoteIdentifier(spec.references.schema)}.${quoteIdentifier(spec.references.table)} ${quoteColumnList(spec.references.columns)} ` +
      `ON UPDATE ${FOREIGN_KEY_ACTION_SQL[spec.onUpdate]} ON DELETE ${FOREIGN_KEY_ACTION_SQL[spec.onDelete]}`,
  )
  return sealPlan({
    statements,
    description: `add foreign key ${name} on ${spec.schema}.${spec.table}`,
  })
}

// Exposure plans (V02-13). GRANT/REVOKE take no parameters for identifiers,
// so every identifier is validated and quoted by the audited helper and
// every literal passes the strict shape checks before quoteLiteral renders
// it. The registry statements are DML over the migration-owned table and
// render only validated literals for the same reason.

export interface ColumnPrivilegeGrant {
  readonly privilege: "SELECT" | "INSERT" | "UPDATE"
  readonly columns: readonly string[]
}

// The runtime privilege tokens have the same runtime allowlist discipline as
// the foreign-key actions: the type pins the literal, and the compiler still
// re-validates before rendering, so a caller that bypasses the type system
// (a cast or a comment-style token) is refused instead of being interpolated.
const COLUMN_PRIVILEGE_SQL: Readonly<
  Record<ColumnPrivilegeGrant["privilege"], string>
> = Object.freeze({
  SELECT: "SELECT",
  INSERT: "INSERT",
  UPDATE: "UPDATE",
})

export interface GrantRuntimePrivilegesSpec {
  readonly schema: string
  readonly table: string
  /** The restricted runtime role receiving least-privilege grants. */
  readonly role: string
  /** Grant USAGE on the schema (idempotent; kept for sibling tables). */
  readonly grantSchemaUsage: boolean
  /** Grant DELETE at table level; the data contract requires deleteById. */
  readonly grantDelete: boolean
  /** Non-empty column lists only; empty grants are omitted by the service. */
  readonly columnGrants: readonly ColumnPrivilegeGrant[]
}

export function compileGrantRuntimePrivileges(
  spec: GrantRuntimePrivilegesSpec,
): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  assertDdlIdentifier(spec.role)
  const statements: string[] = []
  if (spec.grantSchemaUsage) {
    statements.push(
      `GRANT USAGE ON SCHEMA ${quoteIdentifier(spec.schema)} TO ${quoteIdentifier(spec.role)}`,
    )
  }
  if (spec.grantDelete) {
    statements.push(
      `GRANT DELETE ON TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} TO ${quoteIdentifier(spec.role)}`,
    )
  }
  for (const grant of spec.columnGrants) {
    if (!Object.hasOwn(COLUMN_PRIVILEGE_SQL, grant.privilege)) {
      throw invalidInput(
        `column privilege "${String(grant.privilege)}" is not allowlisted`,
      )
    }
    assertKeyColumns(grant.columns, `a ${grant.privilege} grant`)
    statements.push(
      `GRANT ${COLUMN_PRIVILEGE_SQL[grant.privilege]} ${quoteColumnList(grant.columns)} ` +
        `ON TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} TO ${quoteIdentifier(spec.role)}`,
    )
  }
  if (statements.length === 0) {
    throw invalidInput("a privilege grant plan needs at least one statement")
  }
  return sealPlan({
    statements,
    description: `grant runtime privileges on ${spec.schema}.${spec.table}`,
  })
}

export interface RevokeRuntimePrivilegesSpec {
  readonly schema: string
  readonly table: string
  readonly role: string
}

export function compileRevokeRuntimePrivileges(
  spec: RevokeRuntimePrivilegesSpec,
): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  assertDdlIdentifier(spec.role)
  // Table-level REVOKE also removes column-level grants of these privileges,
  // so the column-level grants applied by compileGrantRuntimePrivileges are
  // revoked here without tracking their exact shape. USAGE on the schema is
  // intentionally kept: sibling tables in the same schema may stay exposed.
  const statement =
    `REVOKE SELECT, INSERT, UPDATE, DELETE ` +
    `ON TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} FROM ${quoteIdentifier(spec.role)}`
  return sealPlan({
    statements: [statement],
    description: `revoke runtime privileges on ${spec.schema}.${spec.table}`,
  })
}

// SQLSTATE raised by the unexpose residual-privilege guard when the runtime
// role still holds any SELECT/INSERT/UPDATE on a column or DELETE on the
// table after the revoke. Class 9C is application-defined (same discipline
// as STALE_SOURCE_TYPE_SQLSTATE), and DDL_ERROR_MAP translates it to a
// conflict so the whole unexpose transaction rolls back.
export const RESIDUAL_RUNTIME_PRIVILEGES_SQLSTATE = "9C002"

export interface VerifyRuntimePrivilegesRevokedSpec {
  readonly schema: string
  readonly table: string
  readonly role: string
}

/**
 * Compile the fail-closed guard that runs AFTER the unexpose REVOKE inside
 * the same advisory-locked transaction. A REVOKE removes only grants made
 * by the revoker, so a privilege granted to the runtime role by a different
 * role would survive and leave the table reachable after the registry row
 * says unexposed; this guard re-reads the runtime role's effective
 * privileges under the same lock and raises when anything residual remains,
 * rolling the registry update back with it. All catalogue and privilege
 * functions are pg_catalog-qualified (the executor pins search_path, and
 * the guard must stay correct even if that pinning ever loosens), and the
 * body carries no caller input beyond strictly validated, literal-quoted
 * identifiers, exactly like the locked source-type assertion.
 */
export function compileVerifyRuntimePrivilegesRevoked(
  spec: VerifyRuntimePrivilegesRevokedSpec,
): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  assertDdlIdentifier(spec.role)
  const role = quoteLiteral(spec.role)
  const qualified = quoteLiteral(`${spec.schema}.${spec.table}`)
  const statement = `DO $microjbase$
BEGIN
  IF pg_catalog.has_table_privilege(${role}, ${qualified}, 'DELETE') THEN
    RAISE EXCEPTION 'runtime role retains DELETE on the unexposed table'
      USING ERRCODE = '${RESIDUAL_RUNTIME_PRIVILEGES_SQLSTATE}';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${quoteLiteral(spec.schema)}
      AND c.relname = ${quoteLiteral(spec.table)}
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND (
        pg_catalog.has_column_privilege(${role}, ${qualified}, a.attname, 'SELECT')
        OR pg_catalog.has_column_privilege(${role}, ${qualified}, a.attname, 'INSERT')
        OR pg_catalog.has_column_privilege(${role}, ${qualified}, a.attname, 'UPDATE')
      )
  ) THEN
    RAISE EXCEPTION 'runtime role retains column privileges on the unexposed table'
      USING ERRCODE = '${RESIDUAL_RUNTIME_PRIVILEGES_SQLSTATE}';
  END IF;
END
$microjbase$`
  return sealPlan({
    statements: [statement],
    description: `verify runtime privileges were revoked on ${spec.schema}.${spec.table}`,
  })
}

// Registry literals pass the same strict shape validation as the import
// payload before they are rendered, so they can never break out of the
// statement even though PostgreSQL accepts no parameters here.
function assertRegistryAlias(alias: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(alias)) {
    throw invalidInput("registry alias is not a valid alias")
  }
}

function assertRegistryIdentifier(name: string, context: string): void {
  if (!SIMPLE_IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw invalidInput(`${context} is not a valid identifier`)
  }
}

export interface MarkExposedSpec {
  readonly alias: string
  readonly schema: string
  readonly table: string
}

export function compileMarkExposed(spec: MarkExposedSpec): DdlPlan {
  assertRegistryAlias(spec.alias)
  assertRegistryIdentifier(spec.schema, "registry schema")
  assertRegistryIdentifier(spec.table, "registry table")
  const alias = quoteLiteral(spec.alias)
  const schema = quoteLiteral(spec.schema)
  const table = quoteLiteral(spec.table)
  const statement =
    `INSERT INTO microjbase.exposure_registry ` +
    `(alias, schema_name, table_name, exposed, exposed_at, unexposed_at, updated_at) ` +
    `VALUES (${alias}, ${schema}, ${table}, TRUE, now(), NULL, now()) ` +
    `ON CONFLICT (schema_name, table_name) DO UPDATE SET ` +
    `alias = EXCLUDED.alias, exposed = TRUE, exposed_at = now(), ` +
    `unexposed_at = NULL, updated_at = now()`
  return sealPlan({
    statements: [statement],
    description: "mark a table exposed in the durable exposure registry",
  })
}

export interface MarkUnexposedSpec {
  readonly schema: string
  readonly table: string
}

export function compileMarkUnexposed(spec: MarkUnexposedSpec): DdlPlan {
  assertRegistryIdentifier(spec.schema, "registry schema")
  assertRegistryIdentifier(spec.table, "registry table")
  const schema = quoteLiteral(spec.schema)
  const table = quoteLiteral(spec.table)
  const statement =
    `UPDATE microjbase.exposure_registry SET exposed = FALSE, ` +
    `unexposed_at = now(), updated_at = now() ` +
    `WHERE schema_name = ${schema} AND table_name = ${table}`
  return sealPlan({
    statements: [statement],
    description: "mark a table unexposed in the durable exposure registry",
  })
}

// ---------------------------------------------------------------------------
// V02-14..V02-15 typed builders: row-security state management and the
// predefined user_id ownership policy templates (D-019). The same invariants
// apply: identifiers pass conservative validation and one quoting helper,
// internal schemas are refused before SQL exists, and every statement carries
// exactly one command. Policy expressions have no caller-supplied fragment:
// every template renders one fixed ownership comparison against the
// transaction-local microjbase.user_id setting.
// ---------------------------------------------------------------------------

export interface RowSecurityTargetSpec {
  readonly schema: string
  readonly table: string
}

// Enablement always forces RLS as well: an exposed table must never sit with
// row security enabled but unforced, because the table owner (and any other
// non-policy-checked path) would silently bypass the policies the runtime
// lane is subject to.
export function compileEnableRowSecurity(spec: RowSecurityTargetSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  const target = `${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)}`
  return sealPlan({
    statements: [
      `ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${target} FORCE ROW LEVEL SECURITY`,
    ],
    description: `enable and force row-level security on ${spec.schema}.${spec.table}`,
  })
}

// Disablement drops the FORCE flag before disabling RLS so the relforcerow
// security bit never outlives the row-security bit inside the same
// transaction. The plan itself leads with the locked exposure guard: the
// process-local registry the service preflight read can be stale by the time
// the executor reaches the advisory lock, so the durable registry is
// re-checked as the first statement and the disable fails closed there
// instead (R6, JDW-28).
export function compileDisableRowSecurity(
  spec: RowSecurityTargetSpec,
): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  const target = `${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)}`
  return sealPlan({
    statements: [
      exposedGuardStatement(spec.schema, spec.table),
      `ALTER TABLE ${target} NO FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE ${target} DISABLE ROW LEVEL SECURITY`,
    ],
    description: `disable row-level security on ${spec.schema}.${spec.table}`,
  })
}

/**
 * The four predefined ownership templates (D-019). Each binds one command to
 * the fixed `microjbase.user_id` ownership comparison; there is deliberately
 * no arbitrary policy-expression path.
 */
export type OwnershipPolicyTemplate = "read" | "insert" | "update" | "delete"

interface OwnershipPolicyTemplateShape {
  /** The PostgreSQL FOR command the template compiles to. */
  readonly command: "SELECT" | "INSERT" | "UPDATE" | "DELETE"
  /** Whether the template renders a USING clause. */
  readonly using: boolean
  /** Whether the template renders a WITH CHECK clause. */
  readonly withCheck: boolean
}

const OWNERSHIP_POLICY_TEMPLATES: Readonly<
  Record<OwnershipPolicyTemplate, OwnershipPolicyTemplateShape>
> = Object.freeze({
  read: { command: "SELECT", using: true, withCheck: false },
  insert: { command: "INSERT", using: false, withCheck: true },
  update: { command: "UPDATE", using: true, withCheck: true },
  delete: { command: "DELETE", using: true, withCheck: false },
})

/**
 * The clause shape each ownership template renders. Exposure verification
 * (schema-exposure.ts) re-derives the exact expressions a managed policy
 * must carry from this same table, so the two can never drift apart.
 */
export function ownershipPolicyTemplateShape(
  template: OwnershipPolicyTemplate,
): OwnershipPolicyTemplateShape {
  return OWNERSHIP_POLICY_TEMPLATES[template]
}

// The frozen ownership comparison every template applies to the validated
// UUID ownership column. The transaction-local GUC carries the request
// identity set by the runtime lane; an empty or missing setting never
// matches a row, so an unset identity fails closed instead of seeing all.
const OWNERSHIP_EXPRESSION =
  "nullif(current_setting('microjbase.user_id', true), '')::uuid"

export interface OwnershipPolicySpec {
  readonly schema: string
  readonly table: string
  /** The validated UUID ownership column the template binds to. */
  readonly column: string
  readonly template: OwnershipPolicyTemplate
  /** The restricted runtime role the policy applies TO. */
  readonly role: string
}

export interface DropOwnershipPolicySpec {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly template: OwnershipPolicyTemplate
}

/**
 * Deterministic module-owned policy name. Removal addresses policies only by
 * this name, so a removal command can never target an operator-authored
 * policy; and the mjb_ prefix keeps module-created objects distinguishable
 * in the catalogue (D-029 naming scheme extended to policies).
 */
export function ownershipPolicyName(
  table: string,
  column: string,
  template: OwnershipPolicyTemplate,
): string {
  return deterministicObjectName(template, table, [column])
}

/**
 * Render the frozen ownership comparison exactly as the policy compiler
 * emits it. Exposure verification re-uses this renderer (through a rolled-
 * back probe policy it deparses with pg_get_expr) so the expression it
 * requires of managed policies can never drift from the one the compiler
 * writes (JDW-27).
 */
export function compileOwnershipComparison(column: string): string {
  return `${quoteIdentifier(column)} = ${OWNERSHIP_EXPRESSION}`
}

function assertOwnershipPolicySpec(
  spec: OwnershipPolicySpec | DropOwnershipPolicySpec,
): OwnershipPolicyTemplateShape {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  assertDdlIdentifier(spec.column)
  const template = OWNERSHIP_POLICY_TEMPLATES[spec.template]
  if (template === undefined) {
    throw invalidInput(`policy template "${spec.template}" is not allowlisted`)
  }
  return template
}

export function compileCreateOwnershipPolicy(
  spec: OwnershipPolicySpec,
): DdlPlan {
  const template = assertOwnershipPolicySpec(spec)
  assertDdlIdentifier(spec.role)
  const name = ownershipPolicyName(spec.table, spec.column, spec.template)
  assertDdlName(name, "policy name")
  const target = `${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)}`
  const comparison = compileOwnershipComparison(spec.column)
  let statement =
    `CREATE POLICY ${quoteIdentifier(name)} ON ${target} ` +
    `FOR ${template.command} TO ${quoteIdentifier(spec.role)}`
  if (template.using) {
    statement += ` USING (${comparison})`
  }
  if (template.withCheck) {
    statement += ` WITH CHECK (${comparison})`
  }
  return sealPlan({
    statements: [statement],
    description: `create ${spec.template} ownership policy on ${spec.schema}.${spec.table}`,
  })
}

export function compileDropOwnershipPolicy(
  spec: DropOwnershipPolicySpec,
): DdlPlan {
  assertOwnershipPolicySpec(spec)
  const name = ownershipPolicyName(spec.table, spec.column, spec.template)
  assertDdlName(name, "policy name")
  const target = `${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)}`
  const statement = `DROP POLICY ${quoteIdentifier(name)} ON ${target}`
  return sealPlan({
    statements: [statement],
    description: `drop ${spec.template} ownership policy on ${spec.schema}.${spec.table}`,
  })
}

// ---------------------------------------------------------------------------
// Locked exposure guards (JDW-27). The preflight services read the in-memory
// table registry or the live catalogue before the executor acquires its
// connection and advisory lock, so a concurrent expose can commit in that
// window and the preflight answer is stale. These guards are compiled as the
// FIRST statement of the affected plans, so they re-read the durable
// microjbase.exposure_registry and the catalogue relflags under the same
// advisory lock as the mutation itself and raise a class-9C SQLSTATE the
// executor maps to a conflict, rolling the whole transaction back. All
// catalogue references are pg_catalog-qualified and every embedded value is a
// strictly validated literal, exactly like the locked source-type assertion.
// ---------------------------------------------------------------------------

// The single-statement guard body shared by compileAssertNotExposed and the
// cascading-foreign-key refusal, so the compiled probe and every caller emit
// byte-identical SQL.
function exposedGuardStatement(schema: string, table: string): string {
  const schemaLiteral = quoteLiteral(schema)
  const tableLiteral = quoteLiteral(table)
  return `DO $microjbase$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM microjbase.exposure_registry
    WHERE schema_name = ${schemaLiteral}
      AND table_name = ${tableLiteral}
      AND exposed = TRUE
  ) THEN
    RAISE EXCEPTION 'table is exposed to the data API and cannot be modified'
      USING ERRCODE = '${EXPOSED_MUTATION_GUARD_SQLSTATE}';
  END IF;
END
$microjbase$`
}

/**
 * Compile the locked exposure guard for a structural mutation or an RLS
 * disablement: raise EXPOSED_MUTATION_GUARD_SQLSTATE when the durable
 * registry lists the target as exposed. The in-memory preflight stays in
 * place as the friendly early error; this is the authoritative check.
 */
export function compileAssertNotExposed(spec: RowSecurityTargetSpec): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  return sealPlan({
    statements: [exposedGuardStatement(spec.schema, spec.table)],
    description: `assert ${spec.schema}.${spec.table} is not exposed`,
  })
}

export interface ExposurePrerequisiteSpec {
  readonly schema: string
  readonly table: string
  /** The restricted runtime role the exposure grants apply to. */
  readonly role: string
}

/**
 * Compile the locked prerequisite guard for an expose: refuse when the target
 * is already exposed in the durable registry (so a second concurrent expose
 * conflicts instead of renaming the public alias), when row security is not
 * enabled and forced, or when no RLS policy applies to the runtime role. The
 * guard runs before any GRANT or registry upsert inside the same advisory
 * lock, so an expose can never commit against drifted RLS state.
 */
export function compileAssertExposurePrerequisites(
  spec: ExposurePrerequisiteSpec,
): DdlPlan {
  assertManageableSchema(spec.schema)
  assertDdlIdentifier(spec.table)
  assertDdlIdentifier(spec.role)
  const schemaLiteral = quoteLiteral(spec.schema)
  const tableLiteral = quoteLiteral(spec.table)
  const roleLiteral = quoteLiteral(spec.role)
  const statement = `DO $microjbase$
DECLARE
  microjbase_security_forced boolean;
  microjbase_policy_applies boolean;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM microjbase.exposure_registry
    WHERE schema_name = ${schemaLiteral}
      AND table_name = ${tableLiteral}
      AND exposed = TRUE
  ) THEN
    RAISE EXCEPTION 'table is already exposed to the data API'
      USING ERRCODE = '${EXPOSURE_GUARD_SQLSTATE}';
  END IF;
  SELECT (c.relrowsecurity AND c.relforcerowsecurity)
    INTO microjbase_security_forced
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ${schemaLiteral}
    AND c.relname = ${tableLiteral}
    AND c.relkind = 'r';
  IF microjbase_security_forced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'row-level security is not enabled and forced on the table'
      USING ERRCODE = '${EXPOSURE_GUARD_SQLSTATE}';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schemaLiteral}
      AND c.relname = ${tableLiteral}
      AND (
        pol.polroles = ARRAY[0]::oid[]
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(pol.polroles) AS policy_role
          WHERE pg_catalog.pg_has_role(${roleLiteral}, policy_role, 'MEMBER')
        )
      )
  ) INTO microjbase_policy_applies;
  IF microjbase_policy_applies IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'no row-level security policy applies to the runtime role'
      USING ERRCODE = '${EXPOSURE_GUARD_SQLSTATE}';
  END IF;
END
$microjbase$`
  return sealPlan({
    statements: [statement],
    description: `assert ${spec.schema}.${spec.table} satisfies exposure prerequisites`,
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
  "42704": {
    code: "TABLE_NOT_FOUND",
    message: "Referenced object does not exist",
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
  "42710": {
    code: "CONFLICT",
    message: "Object already exists",
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
  // Raised by the locked source-type re-check compiled into every
  // changeColumnType plan: the catalogue type drifted from the compiled
  // fromType before the advisory-locked transaction ran.
  "9C001": {
    code: "CONFLICT",
    message:
      "The column type changed after the operation was compiled; retry with a fresh key",
    status: 409,
  },
  // Raised by the residual-privilege guard compiled into every unexpose
  // plan: the runtime role still holds a privilege on the table after the
  // revoke, so the registry must not record it as unexposed.
  "9C002": {
    code: "CONFLICT",
    message:
      "Runtime role retains privileges on the table; revoke them before unexposing",
    status: 409,
  },
  // Raised by the locked exposure guard compiled into structural mutations
  // and the RLS-disablement plan: the durable registry lists the target as
  // exposed, so the command must not run (R6, JDW-28).
  "9C003": {
    code: "CONFLICT",
    message:
      "Table is exposed to the data API and row-level security cannot be disabled",
    status: 409,
  },
  // Raised by the locked exposure-prerequisite guard compiled into every
  // expose plan: the target is already exposed, row security is not enabled
  // and forced, or no policy applies to the runtime role (JDW-27).
  "9C004": {
    code: "CONFLICT",
    message:
      "Table no longer satisfies the exposure prerequisites; retry with a fresh key",
    status: 409,
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
