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
import {
  getPrivateMetadata,
  normalizeType,
  SUPPORTED_TYPES,
} from "./table-types.js"

interface QueryContext {
  query: <R extends pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<R>>
}

interface VerifiedTable {
  table: ExposedTable
  columnTypes: { readonly [column: string]: string }
}

function requireVerifiedMetadata(table: ExposedTable): VerifiedTable {
  const metadata = getPrivateMetadata(table)
  if (metadata === undefined) {
    throw new AppError("INTERNAL_ERROR", "No verified metadata for table", 500)
  }
  return { table, columnTypes: metadata.columnTypes }
}

function rowToJson(
  row: Record<string, unknown>,
  verified: VerifiedTable,
): DataRow {
  const { table, columnTypes } = verified
  const result: DataRow = {}
  const allowed = new Set(table.readableColumns)

  for (const [key, value] of Object.entries(row)) {
    if (!allowed.has(key)) {
      continue
    }

    if (value === null) {
      result[key] = null
      continue
    }

    const dataType = columnTypes[key]
    if (dataType === undefined) {
      throw new AppError(
        "INTERNAL_ERROR",
        `No type metadata for column ${key}`,
        500,
      )
    }

    const converter = SUPPORTED_TYPES.get(normalizeType(dataType))
    if (converter === undefined) {
      throw new AppError(
        "CONFLICT",
        `Unsupported database type ${dataType} for column ${key}`,
        409,
      )
    }

    result[key] = converter(value)
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
    const verified = requireVerifiedMetadata(table)
    const quotedTable = quoteQualifiedName(
      verified.table.schema,
      verified.table.table,
    )
    const columns = verified.table.readableColumns
    const columnList =
      columns.length > 0
        ? columns.map((c) => quoteIdentifier(c)).join(", ")
        : "NULL"

    return this.withTransaction(identity, async (ctx) => {
      const result = await ctx.query(
        `
          SELECT ${columnList}
          FROM ${quotedTable}
          ORDER BY ${quoteIdentifier("id")} ASC
          LIMIT $1 OFFSET $2
        `,
        [limit, offset],
      )
      return {
        items: result.rows.map((row) =>
          rowToJson(row as Record<string, unknown>, verified),
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
    const verified = requireVerifiedMetadata(table)
    const quotedTable = quoteQualifiedName(
      verified.table.schema,
      verified.table.table,
    )
    const columns = verified.table.readableColumns
    const columnList =
      columns.length > 0
        ? columns.map((c) => quoteIdentifier(c)).join(", ")
        : "NULL"

    return this.withTransaction(identity, async (ctx) => {
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
      return rowToJson(result.rows[0] as Record<string, unknown>, verified)
    })
  }

  async create(input: {
    identity: RequestIdentity
    table: ExposedTable
    values: DataRow
  }): Promise<DataRow> {
    const { identity, table, values } = input
    const verified = requireVerifiedMetadata(table)
    assertColumnsAllowed(values, verified.table.insertableColumns)

    const keys = Object.keys(values)
    if (keys.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "No insertable values provided",
        400,
      )
    }

    const quotedTable = quoteQualifiedName(
      verified.table.schema,
      verified.table.table,
    )
    const columns = keys.map((k) => quoteIdentifier(k)).join(", ")
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ")
    const valueList = keys.map((k) => values[k])

    const readable = verified.table.readableColumns
    const returning =
      readable.length > 0
        ? readable.map((c) => quoteIdentifier(c)).join(", ")
        : "NULL"

    return this.withTransaction(identity, async (ctx) => {
      const result = await ctx.query(
        `
          INSERT INTO ${quotedTable} (${columns})
          VALUES (${placeholders})
          RETURNING ${returning}
        `,
        valueList,
      )
      return rowToJson(result.rows[0] as Record<string, unknown>, verified)
    })
  }

  async updateById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
    values: DataRow
  }): Promise<DataRow | null> {
    const { identity, table, id, values } = input
    const verified = requireVerifiedMetadata(table)
    assertColumnsAllowed(values, verified.table.updatableColumns)

    const keys = Object.keys(values)
    if (keys.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "No updatable values provided",
        400,
      )
    }

    const quotedTable = quoteQualifiedName(
      verified.table.schema,
      verified.table.table,
    )
    const assignments = keys
      .map((k, index) => `${quoteIdentifier(k)} = $${index + 1}`)
      .join(", ")
    const valueList = keys.map((k) => values[k])

    const readable = verified.table.readableColumns
    const returning =
      readable.length > 0
        ? readable.map((c) => quoteIdentifier(c)).join(", ")
        : "NULL"

    return this.withTransaction(identity, async (ctx) => {
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
      return rowToJson(result.rows[0] as Record<string, unknown>, verified)
    })
  }

  async deleteById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
  }): Promise<boolean> {
    const { identity, table, id } = input
    const verified = requireVerifiedMetadata(table)
    const quotedTable = quoteQualifiedName(
      verified.table.schema,
      verified.table.table,
    )

    return this.withTransaction(identity, async (ctx) => {
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

const PG_INTEGRITY_CONSTRAINT_VIOLATION = "23500"
const PG_NOT_NULL_VIOLATION = "23502"
const PG_FOREIGN_KEY_VIOLATION = "23503"
const PG_UNIQUE_VIOLATION = "23505"
const PG_CHECK_VIOLATION = "23514"
const PG_EXCLUSION_VIOLATION = "23P01"
const PG_INVALID_TEXT_REPRESENTATION = "22P02"
const PG_NUMERIC_VALUE_OUT_OF_RANGE = "22003"
const PG_INVALID_DATETIME_FORMAT = "22007"
// RLS WITH CHECK / USING violations surface as insufficient privilege. The
// public mapping must stay generic: no policy names, SQL, or PostgreSQL text.
const PG_INSUFFICIENT_PRIVILEGE = "42501"

function isPostgresError(error: unknown): error is Record<string, unknown> {
  return typeof error === "object" && error !== null
}

function getPostgresCode(error: unknown): string | null {
  if (!isPostgresError(error)) return null
  const code = error["code"]
  if (typeof code === "string") return code
  return null
}

export function translateDataError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error
  }

  const code = getPostgresCode(error)

  if (code === null) {
    return translatePoolError(error)
  }

  switch (code) {
    case PG_UNIQUE_VIOLATION:
    case PG_EXCLUSION_VIOLATION:
      return new AppError("CONFLICT", "A conflict occurred", 409)
    case PG_FOREIGN_KEY_VIOLATION:
      return new AppError("CONFLICT", "A conflict occurred", 409)
    case PG_CHECK_VIOLATION:
    case PG_NOT_NULL_VIOLATION:
    case PG_INTEGRITY_CONSTRAINT_VIOLATION:
      return new AppError("CONFLICT", "A conflict occurred", 409)
    case PG_INVALID_TEXT_REPRESENTATION:
    case PG_NUMERIC_VALUE_OUT_OF_RANGE:
    case PG_INVALID_DATETIME_FORMAT:
      return new AppError("CONFLICT", "A conflict occurred", 409)
    case PG_INSUFFICIENT_PRIVILEGE:
      // RLS rejected the write (e.g. a foreign ownership claim). Same safe
      // public shape as every other conflict: nothing about policies or SQL.
      return new AppError("CONFLICT", "A conflict occurred", 409)
    default:
      return translatePoolError(error)
  }
}

export function createPostgresDataRepository(
  deps: PostgresDataRepositoryDependencies,
): DataRepository {
  return new PostgresDataRepository(deps)
}
