// Opt-in admin HTTP API for microJBase v0.2 (V02-16..V02-18).
//
// This module registers the authenticated capability probe (V02-16) and the
// read-only schema/history endpoints (V02-17); the mutating endpoints
// (V02-18) live in admin-mutation-routes.ts. Routes are registered only when
// the composition root wires the admin lane; with the lane disabled the
// /v1/admin tree does not exist and every such path is a plain 404, so the
// admin surface leaves no fingerprint when opted out (D-012).
//
// All responses on this tree carry Cache-Control: no-store (enforced for
// pre-route failures too by the server onSend hook), and every error goes
// through the safe envelope — no SQL, stack traces, or internals ever leak.

import type { FastifyInstance, FastifyPluginOptions } from "fastify"

import { translatePoolError } from "../database/index.js"
import { AppError } from "../core/index.js"

import {
  type AdminDependencies,
  mapOperationRecord,
  rejectUnlessAdminOperator,
} from "./admin-guard.js"
import { registerAdminMutationRoutes } from "./admin-mutation-routes.js"
import { sendAppError, sendError, sendList, sendSuccess } from "./responses.js"

export type { AdminDependencies } from "./admin-guard.js"

const HISTORY_LIMIT_MAX = 500
const HISTORY_DEFAULT_LIMIT = 50

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminDependencies,
  options: FastifyPluginOptions = {},
): Promise<void> {
  void options

  // V02-16: the only schema-lane endpoint in the wave. Authenticated
  // capability/health probe over the bounded admin pool; proves the admin
  // lane is configured, reachable, and its pool is alive before any real
  // operation is attempted.
  app.get("/v1/admin/schema/capabilities", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "capabilities",
      )
      if (rejected !== null) {
        return rejected
      }

      await deps.pool.query("SELECT 1 AS health")
      return sendSuccess(reply, 200, { status: "ok", database: "ok" })
    } catch (error: unknown) {
      const publicError = translatePoolError(error)
      return sendError(
        reply,
        publicError.status,
        publicError.code,
        publicError.message,
      )
    }
  })

  // V02-17: the whole deterministic schema snapshot — schemas, tables,
  // columns, constraints, indexes, ownership, RLS bits, per-table exposure
  // state, and the migration history — as one immutable, deterministically
  // ordered document.
  app.get("/v1/admin/schema", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "snapshot",
      )
      if (rejected !== null) {
        return rejected
      }

      const snapshot = await deps.snapshot.readSnapshot()
      return sendSuccess(reply, 200, snapshot)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  // V02-17: single-table detail derived from the same deterministic snapshot.
  // A table absent from the snapshot is 404; internal tables are reported by
  // the snapshot's own classification, never presented as manageable.
  app.get("/v1/admin/schema/tables/:schema/:table", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(request, reply, deps, "table")
      if (rejected !== null) {
        return rejected
      }

      const { schema, table } = request.params as {
        schema: string
        table: string
      }
      const snapshot = await deps.snapshot.readSnapshot()
      const found = snapshot.schemas
        .find((entry) => entry.name === schema)
        ?.tables.find((entry) => entry.name === table)
      if (found === undefined) {
        throw new AppError("TABLE_NOT_FOUND", "Resource not found", 404)
      }
      return sendSuccess(reply, 200, found)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  // V02-17: durable operation history, newest first (D-025). Safe
  // snake_case mapping; salted actor fingerprints, never raw actor labels.
  app.get("/v1/admin/schema/history", async (request, reply) => {
    try {
      const rejected = rejectUnlessAdminOperator(
        request,
        reply,
        deps,
        "history",
      )
      if (rejected !== null) {
        return rejected
      }

      const query = request.query as { limit?: unknown; offset?: unknown }
      const limit = parseHistoryLimit(query.limit)
      const offset = parseHistoryOffset(query.offset)

      const records = await deps.history.list({ limit, offset })
      return sendList(
        reply,
        records.map((record) => mapOperationRecord(record)),
        { limit, offset },
      )
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  await registerAdminMutationRoutes(app, deps)
}

function parseHistoryLimit(raw: unknown): number {
  if (raw === undefined) {
    return HISTORY_DEFAULT_LIMIT
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > HISTORY_LIMIT_MAX) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      limit: `Must be an integer between 1 and ${HISTORY_LIMIT_MAX}`,
    })
  }
  return value
}

function parseHistoryOffset(raw: unknown): number {
  if (raw === undefined) {
    return 0
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
      offset: "Must be an integer of 0 or greater",
    })
  }
  return value
}
