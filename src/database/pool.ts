// Bounded PostgreSQL connection pool for microJBase v0.1.
//
// Provides pool creation, lifecycle management, and a typed helper that
// exposes only the operations the rest of the application needs. The pool
// is the only place `pg.Pool` is instantiated.

import { URL } from "node:url"

import pg from "pg"

import { AppError } from "../core/errors.js"

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
  private readonly databaseUrlForErrors: string
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

    this.databaseUrlForErrors = redactUrlPassword(config.databaseUrl)
    this.logger = config.logger

    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: maxConnections,
      connectionTimeoutMillis: acquireTimeoutMs,
      query_timeout: queryTimeoutMs,
      // Keep a small reserve of idle connections so the first request after
      // a quiet period does not pay the TCP+SSL+auth handshake cost.
      idleTimeoutMillis: 30_000,
      // Allow the pool to fail fast if the database is not reachable. The
      // process should surface a startup error, not hang forever.
      allowExitOnIdle: false,
    })

    this.pool.on("error", (error: unknown) => {
      this.logger?.error(
        JSON.stringify({
          level: "error",
          msg: "Unexpected PostgreSQL pool error",
          error: poolErrorMessage(error),
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
      throw translatePoolError(error, this.databaseUrlForErrors)
    }
  }

  async connect(): Promise<pg.PoolClient> {
    this.guardNotClosed()
    try {
      const client = await this.pool.connect()
      return client
    } catch (error: unknown) {
      throw translatePoolError(error, this.databaseUrlForErrors)
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

function redactUrlPassword(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) {
      parsed.password = "***"
    }
    return parsed.toString()
  } catch {
    return "***"
  }
}

function poolErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function translatePoolError(
  error: unknown,
  databaseUrlForErrors: string,
): AppError {
  if (error instanceof AppError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)

  // Class 08 — connection errors.
  if (message.startsWith("connect ECONNREFUSED")) {
    return new AppError(
      "DATABASE_UNAVAILABLE",
      `Could not connect to database at ${databaseUrlForErrors}`,
      503,
    )
  }

  if (message.startsWith("Connection terminated")) {
    return new AppError(
      "DATABASE_UNAVAILABLE",
      "Database connection was terminated unexpectedly",
      503,
    )
  }

  if (message.includes("timeout")) {
    return new AppError(
      "DATABASE_UNAVAILABLE",
      "Database operation timed out",
      503,
    )
  }

  if (message.includes("password authentication failed")) {
    return new AppError(
      "DATABASE_UNAVAILABLE",
      "Database authentication failed",
      503,
    )
  }

  return new AppError(
    "INTERNAL_ERROR",
    "An unexpected database error occurred",
    500,
  )
}
