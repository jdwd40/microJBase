// Transaction helper for microJBase v0.1.
//
// Runs a block inside BEGIN/COMMIT (or ROLLBACK on failure) on a pooled
// client, with the request identity set transaction-locally as
// `microjbase.user_id`. The local flag guarantees the value is cleared when
// the transaction ends, so a subsequent borrower of the same physical
// connection cannot see it.

import type pg from "pg"

import { AppError } from "../core/index.js"
import type { UserId } from "../contracts/index.js"
import { translatePoolError } from "./pool.js"

export interface TransactionContext {
  client: pg.PoolClient
  query<R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>
}

export interface TransactionOptions {
  /** User identity to set transaction-locally. If omitted, no identity is set. */
  userId?: UserId
}

export interface TransactionRunner {
  withTransaction<T>(
    block: (ctx: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>
}

class PooledTransactionRunner implements TransactionRunner {
  constructor(private readonly connect: () => Promise<pg.PoolClient>) {}

  async withTransaction<T>(
    block: (ctx: TransactionContext) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const client = await this.connect()

    const release = (err?: Error | boolean): void => {
      client.release(err)
    }

    try {
      await client.query("BEGIN")

      if (options.userId !== undefined) {
        await client.query(
          "SELECT set_config('microjbase.user_id', $1, true)",
          [options.userId],
        )
      }

      const ctx: TransactionContext = {
        client,
        query: (text, values) => client.query(text, values),
      }

      const result = await block(ctx)
      await client.query("COMMIT")
      release()
      return result
    } catch (error: unknown) {
      try {
        await client.query("ROLLBACK")
      } catch (rollbackError: unknown) {
        // If rollback itself fails, force the client out of the pool.
        release(
          rollbackError instanceof Error
            ? rollbackError
            : new Error(String(rollbackError)),
        )
        throw translatePoolError(rollbackError)
      }
      release()
      throw translatePoolError(error)
    }
  }
}

export function createTransactionRunner(
  connect: () => Promise<pg.PoolClient>,
): TransactionRunner {
  return new PooledTransactionRunner(connect)
}

export function translateTransactionError(error: unknown): AppError {
  return translatePoolError(error)
}
