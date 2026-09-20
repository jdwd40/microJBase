// Bearer token parsing helper for microJBase v0.1.
//
// Strict parsing: only `Authorization: Bearer <token>` is accepted.
// Malformed or missing headers return null; the caller maps this to
// 401 AUTH_REQUIRED. Raw tokens are never logged or persisted.

const BEARER_PREFIX = "Bearer "
const BEARER_PREFIX_LOWER = "bearer "

/**
 * Extract a raw token from an Authorization header value.
 * Returns null if the header is missing, malformed, or not Bearer.
 */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | null {
  if (header === undefined || header === "") {
    return null
  }

  let value: string
  if (Array.isArray(header)) {
    // Multiple Authorization headers are invalid.
    if (header.length !== 1) {
      return null
    }
    value = header[0] ?? ""
  } else {
    value = header
  }

  value = value.trim()

  // Must be exactly `Bearer <token>`; be case-sensitive except for the
  // leading `Bearer` word, which we accept in either casing per RFC 9110.
  if (
    !value.startsWith(BEARER_PREFIX) &&
    !value.startsWith(BEARER_PREFIX_LOWER)
  ) {
    return null
  }

  const prefixLength =
    value.length >= BEARER_PREFIX.length &&
    value.slice(0, BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX_LOWER
      ? BEARER_PREFIX.length
      : BEARER_PREFIX_LOWER.length
  const token = value.slice(prefixLength).trim()
  if (token.length === 0) {
    return null
  }

  return token
}
