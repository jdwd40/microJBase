// Bounded PostgreSQL connection pool for microJBase v0.1.
//
// Provides pool creation, lifecycle management, and a typed helper that
// exposes only the operations the rest of the application needs. The pool
// is the only place `pg.Pool` is instantiated.

import pg from "pg"

import { AppError } from "../core/index.js"

export interface PoolConfig {
  /** PostgreSQL connection URL. The password is redacted in error text. */
  databaseUrl: string
  /** Maximum number of clients the pool may hold. Defaults to 10. */
  maxConnections?: number
  /** Milliseconds to wait for a client from the pool before failing. */
  acquireTimeoutMs?: number
  /** Milliseconds to allow a query to run before failing. */
  queryTimeoutMs?: number
  /** Optional logger. Errors are logged here before being translated. */
  logger?: Pick<Console, "error" | "warn" | "info" | "debug">
}

export interface Pool extends AsyncDisposable {
  /** Execute a single query using a checked-out client. */
  query<R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>

  /** Acquire a client. Caller MUST call `release()`. */
  connect(): Promise<pg.PoolClient>

  /** Gracefully close idle clients and drain the pool. */
  close(): Promise<void>
}

const DEFAULT_MAX_CONNECTIONS = 10
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000
const DEFAULT_QUERY_TIMEOUT_MS = 10_000

class BoundedPool implements Pool {
  private readonly pool: pg.Pool
  private readonly logger?: PoolConfig["logger"]
  private closed = false

  constructor(config: PoolConfig) {
    const maxConnections = positiveIntOrDefault(
      config.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
      "maxConnections",
    )
    const acquireTimeoutMs = positiveIntOrDefault(
      config.acquireTimeoutMs,
      DEFAULT_ACQUIRE_TIMEOUT_MS,
      "acquireTimeoutMs",
    )
    const queryTimeoutMs = positiveIntOrDefault(
      config.queryTimeoutMs,
      DEFAULT_QUERY_TIMEOUT_MS,
      "queryTimeoutMs",
    )

    this.logger = config.logger

    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: maxConnections,
      connectionTimeoutMillis: acquireTimeoutMs,
      query_timeout: queryTimeoutMs,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: false,
    })

    this.pool.on("error", (error: unknown) => {
      const errorType =
        error instanceof Error ? error.constructor.name : typeof error
      this.logger?.error(
        JSON.stringify({
          level: "error",
          event: "postgresql_pool_error",
          errorType,
        }),
      )
    })
  }

  async query<R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    this.guardNotClosed()
    try {
      return await this.pool.query<R>(text, values)
    } catch (error: unknown) {
      throw translatePoolError(error)
    }
  }

  async connect(): Promise<pg.PoolClient> {
    this.guardNotClosed()
    try {
      const client = await this.pool.connect()
      return client
    } catch (error: unknown) {
      throw translatePoolError(error)
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    await this.pool.end()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private guardNotClosed(): void {
    if (this.closed) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Database pool has already been closed",
        500,
      )
    }
  }
}

function positiveIntOrDefault(
  value: number | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined) {
    return defaultValue
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${name} must be a positive integer`,
      400,
      { variable: name },
    )
  }
  return value
}

export function createPool(config: PoolConfig): Pool {
  return new BoundedPool(config)
}

// PostgreSQL SQLSTATE codes and Node network errors that mean the database is
// unreachable or unavailable. These must never leak into public messages.
const DATABASE_UNAVAILABLE_CODES: readonly string[] = [
  // Class 08 — connection exceptions.
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "08007",
  "08P01",
  // Insufficient resources / cannot connect now / too many connections.
  "53300",
  "57000",
  "57014",
  // Operator intervention / crash / recovery.
  "57P01",
  "57P02",
  "57P03",
  // Authentication failure.
  "28P01",
  "28000",
]

const DATABASE_UNAVAILABLE_NODE_CODES: readonly string[] = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]

function isDatabaseUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }

  const candidate = error as Record<string, unknown>

  const code = candidate["code"]
  if (typeof code === "string") {
    if (DATABASE_UNAVAILABLE_CODES.includes(code)) {
      return true
    }
    if (DATABASE_UNAVAILABLE_NODE_CODES.includes(code)) {
      return true
    }
  }

  const sqlState = candidate["sqlState"]
  if (typeof sqlState === "string" && sqlState.startsWith("08")) {
    return true
  }

  const message = error instanceof Error ? error.message : String(error)
  const upper = message.toUpperCase()
  if (
    DATABASE_UNAVAILABLE_NODE_CODES.some((nodeCode) => upper.includes(nodeCode))
  ) {
    return true
  }
  const lower = message.toLowerCase()
  if (
    lower.includes("password authentication failed") ||
    lower.includes("authentication failed")
  ) {
    return true
  }
  if (lower.includes("connect") && lower.includes("refused")) {
    return true
  }
  if (lower.includes("connection terminated")) {
    return true
  }
  if (lower.includes("timeout") && lower.includes("database")) {
    return true
  }

  return false
}

export function translatePoolError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error
  }

  if (isDatabaseUnavailableError(error)) {
    const message = error instanceof Error ? error.message : String(error)
    const lower = message.toLowerCase()

    if (lower.includes("password authentication failed")) {
      return new AppError(
        "DATABASE_UNAVAILABLE",
        "Database authentication failed",
        503,
      )
    }

    if (lower.includes("timeout")) {
      return new AppError(
        "DATABASE_UNAVAILABLE",
        "Database operation timed out",
        503,
      )
    }

    if (lower.includes("connection terminated")) {
      return new AppError(
        "DATABASE_UNAVAILABLE",
        "Database connection was terminated unexpectedly",
        503,
      )
    }

    return new AppError("DATABASE_UNAVAILABLE", "Database is unavailable", 503)
  }

  return new AppError(
    "INTERNAL_ERROR",
    "An unexpected database error occurred",
    500,
  )
}
