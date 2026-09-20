// Health route for microJBase v0.1.
//
// Performs a trivial real database readiness query. Returns 200 only when the
// process and database are healthy; 503 DATABASE_UNAVAILABLE when PostgreSQL
// is unavailable. Exposes no host/name/version/credentials.

import type { FastifyInstance, FastifyPluginOptions } from "fastify"

import { translatePoolError } from "../database/index.js"
import type { Pool } from "../database/index.js"

import { sendError, sendSuccess } from "./responses.js"

interface HealthDependencies {
  pool: Pool
}

export async function registerHealthRoute(
  app: FastifyInstance,
  deps: HealthDependencies,
  options: FastifyPluginOptions = {},
): Promise<void> {
  void options

  app.get("/health", async (_request, reply) => {
    try {
      await deps.pool.query("SELECT 1 AS health")
      return sendSuccess(reply, 200, {
        status: "ok",
        database: "ok",
      })
    } catch (error: unknown) {
      // translatePoolError already distinguishes genuine database
      // unavailability (503 DATABASE_UNAVAILABLE) from unexpected
      // internal failures (500 INTERNAL_ERROR); honour its status.
      const publicError = translatePoolError(error)
      return sendError(
        reply,
        publicError.status,
        publicError.code,
        publicError.message,
      )
    }
  })
}
