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

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-request-id", reply.request.id)
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

    return reply.status(error.statusCode ?? 500).send({
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

  return Promise.all(promises).then(() => undefined)
}
