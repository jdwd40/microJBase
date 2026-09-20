// Small HTTP helpers shared by auth and data routes.
//
// Keeps route handlers focused on transport mapping while avoiding a
// general middleware framework.

import type { FastifyRequest } from "fastify"

/**
 * Extract an unknown request body and verify it is a plain object.
 * Returns null if the body is not a non-array object.
 */
export function getPlainObjectBody(
  request: FastifyRequest,
): Record<string, unknown> | null {
  const body = request.body
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null
  }
  return body as Record<string, unknown>
}
