// HTTP response envelope and error mapping for microJBase v0.1.
//
// All public responses use the frozen envelope from CONTRACTS.md.
// Domain field names are camelCase; HTTP JSON fields are snake_case.

import type { FastifyReply } from "fastify"

import { AppError, toPublicError } from "../core/index.js"
import type { AuthenticatedUser, User } from "../contracts/index.js"

export interface SuccessEnvelope<T> {
  data: T
  error: null
}

export interface ListEnvelope<T> {
  data: T[]
  error: null
  meta: {
    limit: number
    offset: number
  }
}

export interface ErrorEnvelope {
  data: null
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export function sendSuccess<T>(
  reply: FastifyReply,
  statusCode: number,
  data: T,
): FastifyReply {
  return reply.status(statusCode).send({
    data,
    error: null,
  })
}

export function sendList<T>(
  reply: FastifyReply,
  data: T[],
  meta: { limit: number; offset: number },
): FastifyReply {
  return reply.status(200).send({
    data,
    error: null,
    meta,
  })
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  const body: ErrorEnvelope = {
    data: null,
    error: {
      code,
      message,
    },
  }
  if (details !== undefined && Object.keys(details).length > 0) {
    body.error.details = details
  }
  return reply.status(statusCode).send(body)
}

export function sendAppError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const publicError = toPublicError(error)
  return sendError(
    reply,
    publicError.status,
    publicError.code,
    publicError.message,
    publicError.details,
  )
}

export function sendNoCache(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store")
}

export function mapAuthResult(result: {
  user: User
  token: string
  expiresAt: Date
}): {
  user: {
    id: string
    email: string
    created_at: string
  }
  token: string
  expires_at: string
} {
  return {
    user: mapUser(result.user),
    token: result.token,
    expires_at: result.expiresAt.toISOString(),
  }
}

export function mapUser(user: User): {
  id: string
  email: string
  created_at: string
}
export function mapUser(user: AuthenticatedUser): {
  id: string
  email: string
}
export function mapUser(user: User | AuthenticatedUser): {
  id: string
  email: string
  created_at?: string
} {
  const mapped: {
    id: string
    email: string
    created_at?: string
  } = {
    id: user.id,
    email: user.email,
  }
  if ("createdAt" in user && user.createdAt instanceof Date) {
    mapped.created_at = user.createdAt.toISOString()
  }
  return mapped
}

export function mapDataRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  // Data rows are already JSON-ready at the repository boundary.
  return row
}

export function isAppErrorWithStatus(error: unknown, status: number): boolean {
  return error instanceof AppError && error.status === status
}
