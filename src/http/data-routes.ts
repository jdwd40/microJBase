// Authenticated data CRUD HTTP routes for microJBase v0.1.
//
// Implements /v1/data/:table, /v1/data/:table/:id as specified in
// docs/api-spec.md. All routes parse the bearer token, authenticate via
// AuthService, build an identity, and call the existing DataService.

import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyRequest,
} from "fastify"

import type { AuthService } from "../contracts/index.js"
import type { DataService } from "../data/index.js"

import { extractBearerToken } from "./bearer.js"
import { sendAppError, sendList, sendSuccess } from "./responses.js"

interface DataRouteDependencies {
  applicationAccess?: import("../application-access.js").ApplicationAccess
  authService: AuthService
  dataService: DataService
}

export async function registerDataRoutes(
  app: FastifyInstance,
  deps: DataRouteDependencies,
  options: FastifyPluginOptions = {},
): Promise<void> {
  void options
  const access = deps.applicationAccess
  const path = access ? "/v1/apps/:app/data/:table" : "/v1/data/:table"
  async function run<T>(
    request: FastifyRequest,
    operation: (
      service: DataService,
      identity: { userId: string },
    ) => Promise<T>,
  ) {
    const token = extractBearerToken(request.headers.authorization)
    const { app: appId, table } = request.params as {
      app: string
      table: string
    }
    if (access) return access.run(appId, token, table, operation)
    return operation(
      deps.dataService,
      await authenticate(token, deps.authService),
    )
  }
  if (access) {
    app.get("/v1/apps/:app/admin/schema", async (request, reply) => {
      try {
        const { app: appId } = request.params as { app: string }
        return sendSuccess(
          reply,
          200,
          await access.catalogue(
            appId,
            extractBearerToken(request.headers.authorization),
          ),
        )
      } catch (error) {
        return sendAppError(reply, error)
      }
    })
    app.route({
      method: ["PUT", "DELETE"],
      url: "/v1/apps/:app/admin/exposures/:alias",
      handler: async (request, reply) => {
        try {
          const { app: appId, alias } = request.params as {
            app: string
            alias: string
          }
          await access.visibility(
            appId,
            extractBearerToken(request.headers.authorization),
            alias,
            request.method === "PUT",
          )
          return reply.status(204).send()
        } catch (error) {
          return sendAppError(reply, error)
        }
      },
    })
    for (const action of ["authorize", "redeem"] as const) {
      app.post(`/v1/apps/:app/${action}`, async (request, reply) => {
        try {
          const { app: appId } = request.params as { app: string }
          const value = await access.handoff(
            appId,
            extractBearerToken(request.headers.authorization),
            request.body,
            action === "redeem",
          )
          return sendSuccess(
            reply,
            201,
            action === "redeem" ? { token: value } : { code: value },
          )
        } catch (error) {
          return sendAppError(reply, error)
        }
      })
    }
    app.route({
      method: ["PUT", "DELETE"],
      url: "/v1/apps/:app/admin/members/:user",
      handler: async (request, reply) => {
        try {
          const { app: appId, user } = request.params as {
            app: string
            user: string
          }
          await access.setMember(
            appId,
            extractBearerToken(request.headers.authorization),
            user,
            request.method === "PUT",
          )
          return reply.status(204).send()
        } catch (error) {
          return sendAppError(reply, error)
        }
      },
    })
    app.post("/v1/apps/:app/session", async (request, reply) => {
      try {
        const { app: appId } = request.params as { app: string }
        const token = await access.exchange(
          appId,
          extractBearerToken(request.headers.authorization),
        )
        return sendSuccess(reply, 201, { token })
      } catch (error) {
        return sendAppError(reply, error)
      }
    })
  }

  app.get(path, async (request, reply) => {
    try {
      const { table } = request.params as { table: string }
      const query = request.query as {
        limit?: unknown
        offset?: unknown
      }

      const listInput: {
        tableAlias: string
        limit?: number
        offset?: number
      } = {
        tableAlias: table,
      }
      if (query.limit !== undefined) {
        listInput.limit = Number(query.limit)
      }
      if (query.offset !== undefined) {
        listInput.offset = Number(query.offset)
      }

      const page = await run(request, (service, identity) =>
        service.list({ ...listInput, identity }),
      )

      return sendList(reply, page.items, {
        limit: page.limit,
        offset: page.offset,
      })
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.get(`${path}/:id`, async (request, reply) => {
    try {
      const { table, id } = request.params as { table: string; id: string }

      const row = await run(request, (service, identity) =>
        service.get({
          identity,
          tableAlias: table,
          id,
        }),
      )

      return sendSuccess(reply, 200, row)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post(path, async (request, reply) => {
    try {
      const { table } = request.params as { table: string }

      const row = await run(request, (service, identity) =>
        service.create({
          identity,
          tableAlias: table,
          values: request.body,
        }),
      )

      return sendSuccess(reply, 201, row)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.patch(`${path}/:id`, async (request, reply) => {
    try {
      const { table, id } = request.params as { table: string; id: string }

      const row = await run(request, (service, identity) =>
        service.update({
          identity,
          tableAlias: table,
          id,
          values: request.body,
        }),
      )

      return sendSuccess(reply, 200, row)
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.delete(`${path}/:id`, async (request, reply) => {
    try {
      const { table, id } = request.params as { table: string; id: string }

      await run(request, (service, identity) =>
        service.delete({
          identity,
          tableAlias: table,
          id,
        }),
      )

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
