// Authentication HTTP routes for microJBase v0.1.
//
// Implements /v1/auth/register, /v1/auth/login, /v1/auth/logout, and
// /v1/auth/me as specified in docs/api-spec.md.

import type { FastifyInstance, FastifyPluginOptions } from "fastify"

import { AppError } from "../core/index.js"
import type { AuthService } from "../contracts/index.js"

import { extractBearerToken } from "./bearer.js"
import { getPlainObjectBody } from "./helpers.js"
import type { InMemoryRateLimiter } from "./rate-limiter.js"
import {
  mapAuthResult,
  mapUser,
  sendAppError,
  sendNoCache,
  sendSuccess,
} from "./responses.js"

interface AuthRouteDependencies {
  authService: AuthService
  rateLimiter: InMemoryRateLimiter
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDependencies,
  options: FastifyPluginOptions = {},
): Promise<void> {
  void options

  app.post("/v1/auth/register", async (request, reply) => {
    // Cache-Control: no-store must be present on every auth response,
    // including validation and rate-limit errors.
    sendNoCache(reply)
    try {
      const limit = deps.rateLimiter.check(`register:${request.ip}`)
      if (!limit.allowed) {
        return sendAppError(
          reply.header("Retry-After", String(limit.retryAfterSeconds)),
          new AppError("RATE_LIMITED", "Rate limit exceeded", 429),
        )
      }

      const body = getPlainObjectBody(request)
      if (
        body === null ||
        Object.keys(body).length !== 2 ||
        !("email" in body) ||
        !("password" in body)
      ) {
        return sendAppError(
          reply,
          new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
            body: "Must contain exactly email and password",
          }),
        )
      }

      const email = body.email
      const password = body.password
      if (typeof email !== "string" || typeof password !== "string") {
        return sendAppError(
          reply,
          new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
            email: typeof email !== "string" ? "Must be a string" : undefined,
            password:
              typeof password !== "string" ? "Must be a string" : undefined,
          }),
        )
      }

      const result = await deps.authService.register({ email, password })
      return sendSuccess(reply, 201, mapAuthResult(result))
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post("/v1/auth/login", async (request, reply) => {
    // Cache-Control: no-store must be present on every auth response,
    // including validation and rate-limit errors.
    sendNoCache(reply)
    try {
      const limit = deps.rateLimiter.check(`login:${request.ip}`)
      if (!limit.allowed) {
        return sendAppError(
          reply.header("Retry-After", String(limit.retryAfterSeconds)),
          new AppError("RATE_LIMITED", "Rate limit exceeded", 429),
        )
      }

      const body = getPlainObjectBody(request)
      if (
        body === null ||
        Object.keys(body).length !== 2 ||
        !("email" in body) ||
        !("password" in body)
      ) {
        return sendAppError(
          reply,
          new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
            body: "Must contain exactly email and password",
          }),
        )
      }

      const email = body.email
      const password = body.password
      if (typeof email !== "string" || typeof password !== "string") {
        return sendAppError(
          reply,
          new AppError("VALIDATION_ERROR", "Request validation failed", 400, {
            email: typeof email !== "string" ? "Must be a string" : undefined,
            password:
              typeof password !== "string" ? "Must be a string" : undefined,
          }),
        )
      }

      const result = await deps.authService.login({ email, password })
      return sendSuccess(reply, 200, mapAuthResult(result))
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.post("/v1/auth/logout", async (request, reply) => {
    // Cache-Control: no-store must be present on every auth response,
    // including missing/malformed bearer errors and the 204 body.
    sendNoCache(reply)
    try {
      const token = extractBearerToken(request.headers.authorization)
      if (token === null) {
        return sendAppError(
          reply,
          new AppError("AUTH_REQUIRED", "Authentication required", 401),
        )
      }

      await deps.authService.logout(token)
      return reply.status(204).send()
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })

  app.get("/v1/auth/me", async (request, reply) => {
    // Cache-Control: no-store must be present on every auth response,
    // including missing/malformed bearer errors.
    sendNoCache(reply)
    try {
      const token = extractBearerToken(request.headers.authorization)
      if (token === null) {
        return sendAppError(
          reply,
          new AppError("AUTH_REQUIRED", "Authentication required", 401),
        )
      }

      const user = await deps.authService.authenticate(token)
      return sendSuccess(reply, 200, mapUser(user))
    } catch (error: unknown) {
      return sendAppError(reply, error)
    }
  })
}
