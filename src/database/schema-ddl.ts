// Typed DDL planner/compiler and transactional executor for microJBase v0.2
// (V02-06).
//
// This is the single audited DDL layer every later schema mutation command
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
//   refused at the compiler boundary, before any SQL exists.
// - A plan is data (statement list plus a safe description); dry-run executes
//   it inside a transaction that always rolls back and never touches durable
//   history.
// - Real execution serializes on the reserved schema-DDL advisory key
//   7921890504698152930 (distinct from the migration runner key
//   7921890504698152929), records the operation through the V02-05 log with
//   idempotency/replay semantics, and maps PostgreSQL errors to safe
//   envelopes that never leak database internals.
//
// Later waves add builders (alter/drop, indexes, constraints, policies) on
// top of this compiler core; no mutation command ships until its wave.

import type { JsonValue, JsonPrimitive } from "../contracts/index.js"
import { AppError, type ErrorCode } from "../core/index.js"

import type { Pool } from "./pool.js"
import type {
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
// input shapes below can never break out of the literal.
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function assertManageableSchema(schema: string): void {
  if (INTERNAL_SCHEMA_NAMES.has(schema) || schema.startsWith("pg_")) {
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
    case "integer":
    case "bigint": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw invalidInput("integer literal defaults must be whole numbers")
      }
      return String(value)
    }
    case "numeric": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidInput("numeric literal defaults must be finite numbers")
      }
      return String(value)
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
      return " DEFAULT gen_random_uuid()"
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
    if (!(column.type in TYPE_ALLOWLIST)) {
      throw invalidInput(`column type "${column.type}" is not allowlisted`)
    }
    if (seenNames.has(column.name)) {
      throw invalidInput(`duplicate column name "${column.name}"`)
    }
    seenNames.add(column.name)

    const renderedType = TYPE_ALLOWLIST[column.type]
    const nullability = column.nullable ? "" : " NOT NULL"
    const defaultClause = renderDefaultClause(column.type, column.default)
    renderedColumns.push(
      `${quoteIdentifier(column.name)} ${renderedType}${nullability}${defaultClause}`,
    )
  }

  const statement = `CREATE TABLE ${quoteIdentifier(spec.schema)}.${quoteIdentifier(spec.table)} (\n  ${renderedColumns.join(",\n  ")}\n)`
  return {
    statements: [statement],
    description: `create table ${spec.schema}.${spec.table} with ${String(spec.columns.length)} column(s)`,
  }
}

export function describePlan(plan: DdlPlan): readonly string[] {
  return plan.statements
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

export interface SchemaDdlExecutorDependencies {
  pool: Pool
  operationLog: SchemaOperationLog
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
  if (typeof sqlState === "string" && sqlState in DDL_ERROR_MAP) {
    const mapped = DDL_ERROR_MAP[sqlState] as {
      code: ErrorCode
      message: string
      status: number
    }
    return new AppError(mapped.code, mapped.message, mapped.status)
  }
  return new AppError("INTERNAL_ERROR", "Schema operation failed", 500)
}

export interface SchemaDdlExecutor {
  execute(
    plan: DdlPlan | readonly DdlPlan[],
    options: ExecuteOptions,
  ): Promise<ExecuteOutcome>
}

export function createSchemaDdlExecutor(
  deps: SchemaDdlExecutorDependencies,
): SchemaDdlExecutor {
  const statementsOf = (
    plan: DdlPlan | readonly DdlPlan[],
  ): readonly string[] => {
    const plans: readonly DdlPlan[] =
      "statements" in plan ? [plan as DdlPlan] : plan
    return plans.flatMap((p) => [...p.statements])
  }

  async function runInTransaction(
    statements: readonly string[],
  ): Promise<void> {
    const client = await deps.pool.connect()
    try {
      await client.query("BEGIN")
      try {
        await client.query("SELECT pg_advisory_xact_lock($1)", [
          BigInt.asIntN(64, SCHEMA_DDL_LOCK_KEY),
        ])
        for (const statement of statements) {
          await client.query(statement)
        }
        await client.query("COMMIT")
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => {
          // Best-effort rollback; the original error is what matters.
        })
        throw translateDdlError(error)
      }
    } finally {
      client.release()
    }
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
            await client.query("SELECT pg_advisory_xact_lock($1)", [
              BigInt.asIntN(64, SCHEMA_DDL_LOCK_KEY),
            ])
            for (const statement of statements) {
              await client.query(statement)
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

      const outcome = await deps.operationLog.begin({
        idempotencyKey: options.idempotencyKey,
        commandType: options.commandType,
        command: options.command,
        actor: options.actor,
      })

      if (outcome.kind === "replay") {
        deps.logger?.info(
          JSON.stringify({
            level: "info",
            event: "schema_ddl_replay",
            commandType: options.commandType,
          }),
        )
        return { dryRun: false, replayed: true, record: outcome.record }
      }
      if (outcome.kind === "in_progress") {
        throw new AppError(
          "CONFLICT",
          "An identical operation is already in progress",
          409,
          { idempotencyKey: options.idempotencyKey },
        )
      }

      try {
        await runInTransaction(statements)
      } catch (error: unknown) {
        const safeError = translateDdlError(error)
        await deps.operationLog.fail(outcome.record.id, safeError.code)
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

      const record = await deps.operationLog.succeed(outcome.record.id, {
        statementCount: statements.length,
      })
      deps.logger?.info(
        JSON.stringify({
          level: "info",
          event: "schema_ddl_executed",
          commandType: options.commandType,
          statementCount: statements.length,
        }),
      )
      return { dryRun: false, replayed: false, record }
    },
  }
}
