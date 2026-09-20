// Authenticated data CRUD HTTP routes for microJBase v0.1.
//
// Implements /v1/data/:table, /v1/data/:table/:id as specified in
// docs/api-spec.md. All routes parse the bearer token, authenticate via
// AuthService, build an identity, and call the existing DataService.

import type { FastifyInstance, FastifyPluginOptions } from "fastify"

import type { AuthService } from "../contracts/index.js"
import type { DataService } from "../data/service.js"

import { extractBearerToken } from "./bearer.js"
import { sendAppError, sendList, sendSuccess } from "./responses.js"

interface DataRouteDependencies {
  authService: AuthService
  dataService: DataService
}

export async function registerDataRoutes(
  app: FastifyInstance,
  deps: DataRouteDependencies,
  options: FastifyPluginOptions = {},
): Promise<void> {
  void options

  app.get("/v1/data/:table", async (request, reply) => {
    try {
      const token = extractBearerToken(request.headers.authorization)
      const identity = await authenticate(token, deps.authService)
      const { table } = request.params as { table: string }
      const query = request.query as {
        limit?: unknown
        offset?: unknown
      }

      const listInput: {
        identity: { userId: string }
        tableAlias: string
        limit?: number
        offset?: number
      } = {
        identity,
        tableAlias: table,
      }
      if (query.limit !== undefined) {
        listInput.limit = Number(query.limit)
      }
      if (query.offset !== undefined) {
        listInput.offset = Number(query.offset)
      }

      const page = await deps.dataService.list(listInput)

      return sendList(reply, page.items, {
        limit: page.limit,
        offset: page.offset,
      })
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.get("/v1/data/:table/:id", async (request, reply) => {
    try {
      const token = extractBearerToken(request.headers.authorization)
      const identity = await authenticate(token, deps.authService)
      const { table, id } = request.params as { table: string; id: string }

      const row = await deps.dataService.get({
        identity,
        tableAlias: table,
        id,
      })

      return sendSuccess(reply, 200, row)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post("/v1/data/:table", async (request, reply) => {
    try {
      const token = extractBearerToken(request.headers.authorization)
      const identity = await authenticate(token, deps.authService)
      const { table } = request.params as { table: string }

      const row = await deps.dataService.create({
        identity,
        tableAlias: table,
        values: request.body,
      })

      return sendSuccess(reply, 201, row)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.patch("/v1/data/:table/:id", async (request, reply) => {
    try {
      const token = extractBearerToken(request.headers.authorization)
      const identity = await authenticate(token, deps.authService)
      const { table, id } = request.params as { table: string; id: string }

      const row = await deps.dataService.update({
        identity,
        tableAlias: table,
        id,
        values: request.body,
      })

      return sendSuccess(reply, 200, row)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.delete("/v1/data/:table/:id", async (request, reply) => {
    try {
      const token = extractBearerToken(request.headers.authorization)
      const identity = await authenticate(token, deps.authService)
      const { table, id } = request.params as { table: string; id: string }

      await deps.dataService.delete({
        identity,
        tableAlias: table,
        id,
      })

      return reply.status(204).send()
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })
}

async function authenticate(
  token: string | null,
  authService: AuthService,
): Promise<{ userId: string }> {
  if (token === null) {
    const { AppError } = await import("../core/index.js")
    throw new AppError("AUTH_REQUIRED", "Authentication required", 401)
  }

  const user = await authService.authenticate(token)
  return { userId: user.id }
}
