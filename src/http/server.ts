// Fastify HTTP server factory for microJBase v0.1.
//
// Builds a configured Fastify instance with request IDs, body-size limits,
// secret-safe logging, route registration, and safe error mapping.

import { randomBytes } from "node:crypto"

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify"

import type { AuthService } from "../contracts/index.js"
import type { DataService } from "../data/index.js"
import type { Pool } from "../database/index.js"

import { type AdminDependencies, registerAdminRoutes } from "./admin-routes.js"
import { registerAuthRoutes } from "./auth-routes.js"
import { registerDataRoutes } from "./data-routes.js"
import { registerHealthRoute } from "./health.js"
import { InMemoryRateLimiter } from "./rate-limiter.js"

export interface ServerConfig {
  /** If true, Fastify trusts the proxy for client IP. Default false. */
  trustProxy?: boolean
  /** Maximum request body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number
  /** Pino log level. Default 'info'. */
  logLevel?: string
  /**
   * Whether to disable request logging. Tests can set this true to avoid
   * verbose output; production keeps it false.
   */
  disableRequestLogging?: boolean
}

export interface ServerDependencies {
  authService: AuthService
  dataService: DataService
  pool?: Pool
  /**
   * Composed admin-lane surface. Present only when both admin settings are
   * configured (D-012); when absent the /v1/admin route tree is not
   * registered at all and those paths fall through to the 404 handler. The
   * rate limiter is owned by the server so the instance is per-process.
   */
  admin?: Omit<AdminDependencies, "rateLimiter">
}

/**
 * True for request paths under /v1/auth/ or /v1/admin/ (and the bare
 * prefixes). Both trees require Cache-Control: no-store on every response,
 * including Fastify pre-route failures that never reach a handler.
 */
function isNoStorePath(url: string): boolean {
  return (
    url === "/v1/auth" ||
    url.startsWith("/v1/auth/") ||
    url === "/v1/admin" ||
    url.startsWith("/v1/admin/")
  )
}

export async function buildServer(
  deps: ServerDependencies,
  config: ServerConfig = {},
): Promise<FastifyInstance> {
  const opts: FastifyServerOptions = {
    logger: {
      level: config.logLevel ?? "info",
    },
    trustProxy: config.trustProxy ?? false,
    bodyLimit: config.maxBodyBytes ?? 1_048_576,
    requestIdHeader: false,
    genReqId: () => randomBytes(16).toString("hex"),
    disableRequestLogging: config.disableRequestLogging ?? false,
    exposeHeadRoutes: false,
  }

  const app = Fastify(opts)

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", reply.request.id)
    // api-spec requires Cache-Control: no-store on every auth response; the
    // admin tree (V02-16) requires the same, including Fastify pre-route
    // failures (malformed JSON, oversized or empty bodies) that never reach
    // the route handlers.
    if (isNoStorePath(request.url)) {
      reply.header("cache-control", "no-store")
    }
    return payload
  })

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    // Fastify validation errors (malformed params/query/body) become
    // VALIDATION_ERROR in the microJBase envelope.
    if (error.validation) {
      return reply.status(400).send({
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
        },
      })
    }

    // Oversized body is signalled by Fastify as a 413 with code FST_ERR_CTP_BODY_TOO_LARGE.
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send({
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body too large",
        },
      })
    }

    // Malformed JSON is signalled by Fastify as a 400 with code FST_ERR_CTP_INVALID_MEDIA_TYPE
    // or by the JSON parser as statusCode 400.
    const message = error.message.toLowerCase()
    if (
      error.statusCode === 400 &&
      (message.includes("json") ||
        message.includes("unexpected token") ||
        message.includes("body"))
    ) {
      return reply.status(400).send({
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
        },
      })
    }

    // Unmapped Fastify errors (e.g. 415 unsupported media type) must not
    // leak Fastify's status or message into the public envelope; unexpected
    // failures are always 500 INTERNAL_ERROR.
    return reply.status(500).send({
      data: null,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    })
  })

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      data: null,
      error: {
        code: "TABLE_NOT_FOUND",
        message: "Resource not found",
      },
    })
  })

  await registerRoutes(app, deps)

  return app
}

function registerRoutes(
  app: FastifyInstance,
  deps: ServerDependencies,
): Promise<void> {
  const rateLimiter = new InMemoryRateLimiter()
  const promises: Promise<void>[] = []

  if (deps.pool !== undefined) {
    promises.push(registerHealthRoute(app, { pool: deps.pool }))
  }

  promises.push(
    registerAuthRoutes(app, {
      authService: deps.authService,
      rateLimiter,
    }),
  )

  promises.push(
    registerDataRoutes(app, {
      authService: deps.authService,
      dataService: deps.dataService,
    }),
  )

  if (deps.admin !== undefined) {
    // Separate bounded limiter instance for the admin tree: admin traffic is
    // never counted against (nor starved by) the auth limiter and vice
    // versa.
    const adminRateLimiter = new InMemoryRateLimiter({
      attemptsPerWindow: 30,
      windowMs: 60_000,
    })
    promises.push(
      registerAdminRoutes(app, {
        ...deps.admin,
        rateLimiter: adminRateLimiter,
      }),
    )
  }

  return Promise.all(promises).then(() => undefined)
}
