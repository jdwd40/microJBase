// PostgreSQL DataRepository implementation for microJBase v0.1.
//
// Every method runs exactly one CRUD operation inside a transaction with the
// request identity set transaction-locally as `microjbase.user_id`. RLS is the
// final access boundary. Request values are parameterised; dynamic identifiers
// come only from the verified registry and are safely quoted.

import type pg from "pg"

import { AppError } from "../core/index.js"
import type {
  DataRepository,
  DataRow,
  ExposedTable,
  Page,
  RequestIdentity,
} from "../contracts/index.js"

import type { TransactionRunner } from "./transaction.js"
import { quoteIdentifier, quoteQualifiedName } from "./identifier.js"
import { translatePoolError } from "./pool.js"

interface QueryContext {
  query: <R extends pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<R>>
}

const SUPPORTED_TYPES = new Map<
  string,
  (value: unknown) => JsonPrimitive | JsonObject | JsonArray
>([
  ["uuid", asString],
  ["text", asString],
  ["varchar", asString],
  ["character varying", asString],
  ["char", asString],
  ["character", asString],
  ["boolean", asBoolean],
  ["bool", asBoolean],
  ["smallint", asNumber],
  ["integer", asNumber],
  ["int", asNumber],
  ["int4", asNumber],
  ["real", asNumber],
  ["float4", asNumber],
  ["double precision", asNumber],
  ["float8", asNumber],
  ["bigint", asString],
  ["int8", asString],
  ["numeric", asString],
  ["decimal", asString],
  ["date", asIsoString],
  ["timestamp without time zone", asIsoString],
  ["timestamp", asIsoString],
  ["timestamp with time zone", asIsoString],
  ["timestamptz", asIsoString],
  ["json", asJson],
  ["jsonb", asJson],
])

type JsonPrimitive = string | number | boolean | null
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]
type JsonValue = JsonPrimitive | JsonObject | JsonArray

function asString(value: unknown): string {
  if (value === null) return ""
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (value === null) return false
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") return value.toLowerCase() === "true"
  return Boolean(value)
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppError(
        "CONFLICT",
        "Database value cannot be represented as a finite number",
        409,
      )
    }
    return value
  }
  if (value === null) return 0
  if (typeof value === "string") {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      throw new AppError(
        "CONFLICT",
        "Database value cannot be represented as a finite number",
        409,
      )
    }
    return parsed
  }
  throw new AppError(
    "CONFLICT",
    "Database value cannot be represented as a finite number",
    409,
  )
}

function asIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") return value
  if (value === null) return ""
  return String(value)
}

function asJson(value: unknown): JsonValue {
  if (value === null) return null
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as JsonValue
  }
  if (typeof value === "object") {
    if (Buffer.isBuffer(value) || value instanceof Date) {
      throw new AppError(
        "CONFLICT",
        "Database value cannot be represented as JSON",
        409,
      )
    }
    if (Array.isArray(value)) {
      return value.map((item) => asJson(item))
    }
    const result: JsonObject = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = asJson(val)
    }
    return result
  }
  throw new AppError(
    "CONFLICT",
    "Database value cannot be represented as JSON",
    409,
  )
}

function normalizeType(typeName: string): string {
  const lower = typeName.toLowerCase().trim()
  if (lower === "character varying") return "varchar"
  if (lower === "timestamp without time zone") return "timestamp"
  if (lower === "timestamp with time zone") return "timestamptz"
  return lower
}

function rowToJson(
  row: Record<string, unknown>,
  typeByColumn: Map<string, string>,
): DataRow {
  const result: DataRow = {}

  for (const [key, value] of Object.entries(row)) {
    const dataType = typeByColumn.get(key)
    if (dataType === undefined) {
      // Column was returned unexpectedly; exclude rather than leak an
      // unsupported type.
      continue
    }

    if (value === null) {
      result[key] = null
      continue
    }

    const converter = SUPPORTED_TYPES.get(normalizeType(dataType))
    if (converter === undefined) {
      throw new AppError(
        "CONFLICT",
        `Unsupported database type ${dataType} for column ${key}`,
        409,
      )
    }

    result[key] = converter(value) as JsonValue
  }

  return result
}

export interface PostgresDataRepositoryDependencies {
  runner: TransactionRunner
}

class PostgresDataRepository implements DataRepository {
  constructor(private readonly deps: PostgresDataRepositoryDependencies) {}

  async list(input: {
    identity: RequestIdentity
    table: ExposedTable
    limit: number
    offset: number
  }): Promise<Page<DataRow>> {
    const { identity, table, limit, offset } = input
    const quotedTable = quoteQualifiedName(table.schema, table.table)
    const columns = table.readableColumns
    const columnList =
      columns.length > 0
        ? columns.map((c) => quoteIdentifier(c)).join(", ")
        : "NULL"

    return this.withTransaction(table, identity, async (ctx) => {
      const text = `
        SELECT ${columnList}
        FROM ${quotedTable}
        ORDER BY ${quoteIdentifier("id")} ASC
        LIMIT $1 OFFSET $2
      `
      const result = await ctx.query(text, [limit, offset])
      const typeByColumn = await this.fetchColumnTypes(ctx, table)
      return {
        items: result.rows.map((row) =>
          rowToJson(row as Record<string, unknown>, typeByColumn),
        ),
        limit,
        offset,
      }
    })
  }

  async findById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
  }): Promise<DataRow | null> {
    const { identity, table, id } = input
    const quotedTable = quoteQualifiedName(table.schema, table.table)
    const columns = table.readableColumns
    const columnList =
      columns.length > 0
        ? columns.map((c) => quoteIdentifier(c)).join(", ")
        : "NULL"

    return this.withTransaction(table, identity, async (ctx) => {
      const result = await ctx.query(
        `
          SELECT ${columnList}
          FROM ${quotedTable}
          WHERE ${quoteIdentifier("id")} = $1
        `,
        [id],
      )
      if (result.rows.length === 0) {
        return null
      }
      const typeByColumn = await this.fetchColumnTypes(ctx, table)
      return rowToJson(result.rows[0] as Record<string, unknown>, typeByColumn)
    })
  }

  async create(input: {
    identity: RequestIdentity
    table: ExposedTable
    values: DataRow
  }): Promise<DataRow> {
    const { identity, table, values } = input
    assertColumnsAllowed(values, table.insertableColumns)

    const quotedTable = quoteQualifiedName(table.schema, table.table)
    const keys = Object.keys(values)
    const columns = keys.map((k) => quoteIdentifier(k)).join(", ")
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ")
    const valueList = keys.map((k) => values[k])

    const readable = table.readableColumns
    const returning =
      readable.length > 0
        ? readable.map((c) => quoteIdentifier(c)).join(", ")
        : "NULL"

    return this.withTransaction(table, identity, async (ctx) => {
      const result = await ctx.query(
        `
          INSERT INTO ${quotedTable} (${columns})
          VALUES (${placeholders})
          RETURNING ${returning}
        `,
        valueList,
      )
      const typeByColumn = await this.fetchColumnTypes(ctx, table)
      return rowToJson(result.rows[0] as Record<string, unknown>, typeByColumn)
    })
  }

  async updateById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
    values: DataRow
  }): Promise<DataRow | null> {
    const { identity, table, id, values } = input
    assertColumnsAllowed(values, table.updatableColumns)

    const keys = Object.keys(values)
    if (keys.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "No updatable values provided",
        400,
      )
    }

    const quotedTable = quoteQualifiedName(table.schema, table.table)
    const assignments = keys
      .map((k, index) => `${quoteIdentifier(k)} = $${index + 1}`)
      .join(", ")
    const valueList = keys.map((k) => values[k])

    const readable = table.readableColumns
    const returning =
      readable.length > 0
        ? readable.map((c) => quoteIdentifier(c)).join(", ")
        : "NULL"

    return this.withTransaction(table, identity, async (ctx) => {
      const result = await ctx.query(
        `
          UPDATE ${quotedTable}
          SET ${assignments}
          WHERE ${quoteIdentifier("id")} = $${keys.length + 1}
          RETURNING ${returning}
        `,
        [...valueList, id],
      )
      if (result.rows.length === 0) {
        return null
      }
      const typeByColumn = await this.fetchColumnTypes(ctx, table)
      return rowToJson(result.rows[0] as Record<string, unknown>, typeByColumn)
    })
  }

  async deleteById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
  }): Promise<boolean> {
    const { identity, table, id } = input
    const quotedTable = quoteQualifiedName(table.schema, table.table)

    return this.withTransaction(table, identity, async (ctx) => {
      const result = await ctx.query(
        `
          DELETE FROM ${quotedTable}
          WHERE ${quoteIdentifier("id")} = $1
        `,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    })
  }

  private async withTransaction<T>(
    table: ExposedTable,
    identity: RequestIdentity,
    block: (ctx: QueryContext) => Promise<T>,
  ): Promise<T> {
    return this.deps.runner.withTransaction(
      async (ctx) => {
        try {
          return await block(ctx)
        } catch (error: unknown) {
          throw translateDataError(error)
        }
      },
      { userId: identity.userId },
    )
  }

  private async fetchColumnTypes(
    ctx: QueryContext,
    table: ExposedTable,
  ): Promise<Map<string, string>> {
    const result = await ctx.query<{
      column_name: string
      data_type: string
    }>(
      `
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
      `,
      [table.schema, table.table],
    )
    const map = new Map<string, string>()
    for (const row of result.rows) {
      map.set(row.column_name, normalizeType(row.data_type))
    }
    return map
  }
}

function assertColumnsAllowed(
  values: DataRow,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed)
  const invalid: string[] = []
  for (const key of Object.keys(values)) {
    if (!allowedSet.has(key)) {
      invalid.push(key)
    }
  }
  if (invalid.length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Request validation failed",
      400,
      Object.fromEntries(invalid.map((k) => [k, "Column is not allowed"])),
    )
  }
}

export function translateDataError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  // Class 23 — integrity constraint violation.
  if (lower.includes("unique constraint") || lower.includes("duplicate key")) {
    return new AppError("CONFLICT", "A conflict occurred", 409)
  }

  if (
    lower.includes("foreign key constraint") ||
    lower.includes("violates foreign key")
  ) {
    return new AppError("CONFLICT", "A conflict occurred", 409)
  }

  if (
    lower.includes("check constraint") ||
    lower.includes("violates check constraint")
  ) {
    return new AppError("CONFLICT", "A conflict occurred", 409)
  }

  if (lower.includes("not null")) {
    return new AppError("CONFLICT", "A conflict occurred", 409)
  }

  // Class 22 — data exception.
  if (lower.includes("invalid input syntax")) {
    return new AppError("CONFLICT", "A conflict occurred", 409)
  }

  return translatePoolError(error)
}

export function createPostgresDataRepository(
  deps: PostgresDataRepositoryDependencies,
): DataRepository {
  return new PostgresDataRepository(deps)
}
