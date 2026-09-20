// Minimal HTTP client helpers for the E2E acceptance suite.
//
// Every call is a real request against the compiled server over TCP.
// Assertions operate on the frozen public envelope from docs/api-spec.md.

import { randomBytes, randomUUID } from "node:crypto"

export interface ApiResponse {
  status: number
  headers: Headers
  body: unknown
  /** Raw response text (for exact-shape comparisons). */
  text: string
}

export interface ApiClient {
  get(path: string, token?: string): Promise<ApiResponse>
  post(path: string, json: unknown, token?: string): Promise<ApiResponse>
  patch(path: string, json: unknown, token?: string): Promise<ApiResponse>
  del(path: string, token?: string): Promise<ApiResponse>
  /** Send a raw, already-serialized body with an explicit content type. */
  send(
    method: string,
    path: string,
    body?: string,
    headers?: Record<string, string>,
  ): Promise<ApiResponse>
}

export function createApi(baseUrl: string): ApiClient {
  const send = async (
    method: string,
    path: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    })
    const text = await response.text()
    let parsed: unknown = null
    if (text.length > 0) {
      parsed = JSON.parse(text)
    }
    return {
      status: response.status,
      headers: response.headers,
      body: parsed,
      text,
    }
  }

  const jsonHeaders = (
    token?: string,
    hasBody = false,
  ): Record<string, string> => {
    const headers: Record<string, string> = {}
    if (hasBody) {
      headers["content-type"] = "application/json"
    }
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`
    }
    return headers
  }

  return {
    get: (path, token) => send("GET", path, undefined, jsonHeaders(token)),
    post: (path, json, token) =>
      send("POST", path, JSON.stringify(json), jsonHeaders(token, true)),
    patch: (path, json, token) =>
      send("PATCH", path, JSON.stringify(json), jsonHeaders(token, true)),
    del: (path, token) => send("DELETE", path, undefined, jsonHeaders(token)),
    send: (method, path, body, headers = {}) =>
      send(method, path, body, headers),
  }
}

/** Short random suffix so repeated local runs never collide on data. */
export function nonce(): string {
  return randomBytes(6).toString("hex")
}

export interface RegisteredUser {
  token: string
  userId: string
  email: string
}

/** Register a fresh user through the real HTTP API. */
export async function registerUser(
  api: ApiClient,
  email: string,
  password = "correct horse battery staple",
): Promise<RegisteredUser> {
  const response = await api.post("/v1/auth/register", { email, password })
  if (response.status !== 201) {
    throw new Error(
      `register failed for ${email}: ${response.status} ${response.text}`,
    )
  }
  const data = response.body as {
    data: {
      user: { id: string; email: string }
      token: string
      expires_at: string
    }
  }
  return { token: data.data.token, userId: data.data.user.id, email }
}

/** Standard error-envelope assertions. */
export function expectError(
  response: ApiResponse,
  status: number,
  code: string,
): void {
  if (response.status !== status) {
    throw new Error(
      `expected status ${status}, got ${response.status}: ${response.text}`,
    )
  }
  const body = response.body as { data: unknown; error: { code: string } }
  if (body.data !== null) {
    throw new Error(`expected data null, got: ${response.text}`)
  }
  if (body.error?.code !== code) {
    throw new Error(`expected error code ${code}, got: ${response.text}`)
  }
}

/** The public error payload, for equivalence assertions. */
export function publicError(response: ApiResponse): unknown {
  const body = response.body as { error: unknown }
  return body.error
}

export function expectNoStore(response: ApiResponse): void {
  const value = response.headers.get("cache-control")
  if (value !== "no-store") {
    throw new Error(`expected Cache-Control: no-store, got ${String(value)}`)
  }
}

export function randomUuid(): string {
  return randomUUID()
}

/** A syntactically valid-shaped opaque token that was never issued. */
export function unknownToken(): string {
  return randomBytes(32).toString("base64url")
}
