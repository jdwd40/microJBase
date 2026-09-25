// Minimal read-only client for the frozen V02-17 admin surface.
//
// The paths below are the entire contract this client speaks — nothing else
// is called, and no path is constructed from anything other than the frozen
// templates plus URL-encoded operator-supplied identifiers. The envelope
// shape ({ data, error }) is the frozen one from CONTRACTS.md; errors are
// classified into the states the shell renders (auth, rate-limited, error).

export const ENDPOINTS = Object.freeze({
  capabilities: "/v1/admin/schema/capabilities",
  snapshot: "/v1/admin/schema",
  tableDetail: (schema, table) =>
    `/v1/admin/schema/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`,
  history: "/v1/admin/schema/history",
})

const DEFAULT_TIMEOUT_MS = 15_000

function errorResult(status, code, message, retryAfter) {
  const result = { ok: false, status, code, message, retryAfter: null }
  if (retryAfter !== null && retryAfter !== undefined) {
    result.retryAfter = retryAfter
  }
  return result
}

function parseRetryAfter(headers) {
  const raw = headers.get("retry-after")
  if (raw === null) {
    return null
  }
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 0) {
    return null
  }
  return seconds
}

/**
 * One GET against the admin surface.
 *
 * Resolves to { ok: true, data } on a 200 envelope, or
 * { ok: false, status, code, message, retryAfter } for every failure mode:
 *   - status 0  — network/timeout failure ("NETWORK_ERROR")
 *   - status 401 — AUTH_REQUIRED or INVALID_CREDENTIALS
 *   - status 429 — RATE_LIMITED, retryAfter from the Retry-After header
 *   - anything else — the frozen error code from the envelope when present.
 *
 * The token is read from the injected getter at call time, never stored here.
 */
export async function adminFetch(path, options) {
  const getToken = options.getToken
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const token = getToken()
  if (token === null) {
    return errorResult(0, "AUTH_REQUIRED", "Sign in with the operator token.")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(path, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal,
    })
  } catch (cause) {
    const aborted = cause?.name === "AbortError"
    return errorResult(
      0,
      "NETWORK_ERROR",
      aborted
        ? "The server did not respond in time. Check the connection and retry."
        : "Could not reach the server. Check the connection and retry.",
      null,
    )
  } finally {
    clearTimeout(timer)
  }

  let body
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (response.ok) {
    const data = body && typeof body === "object" ? body.data : undefined
    const meta =
      body && typeof body === "object" && "meta" in body ? body.meta : null
    return { ok: true, data, meta }
  }

  const envelopeError =
    body &&
    typeof body === "object" &&
    body.error &&
    typeof body.error === "object"
      ? body.error
      : null
  const code =
    typeof envelopeError?.code === "string"
      ? envelopeError.code
      : "INTERNAL_ERROR"
  const message =
    typeof envelopeError?.message === "string"
      ? envelopeError.message
      : "Request failed."
  return errorResult(
    response.status,
    code,
    message,
    parseRetryAfter(response.headers),
  )
}

/** The frozen read-only admin surface as typed calls over adminFetch. */
export function createAdminClient(options) {
  return {
    capabilities: () => adminFetch(ENDPOINTS.capabilities, options),
    snapshot: () => adminFetch(ENDPOINTS.snapshot, options),
    tableDetail: (schema, table) =>
      adminFetch(ENDPOINTS.tableDetail(schema, table), options),
    history: (limit, offset) =>
      adminFetch(
        `${ENDPOINTS.history}?limit=${limit}&offset=${offset}`,
        options,
      ),
  }
}
