// Unit coverage for the management UI's read-only client: envelope parsing,
// error classification (401/429/network), header handling, and the frozen
// endpoint set. Fetch is injected, so no server or DOM is needed.

import { describe, expect, it } from "vitest"

// @ts-expect-error plain-JS browser module, untyped import boundary
import * as api from "../../../../admin-ui/api.js"
// @ts-expect-error plain-JS browser module, untyped import boundary
import * as tokenStore from "../../../../admin-ui/token-store.js"

const FROZEN_PATHS = new Set([
  "/v1/admin/schema/capabilities",
  "/v1/admin/schema",
  "/v1/admin/schema/history",
])

function jsonResponse(status: number, body: unknown, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

describe("frozen endpoint set", () => {
  it("speaks only the V02-17 read paths", () => {
    expect(api.ENDPOINTS.capabilities).toBe("/v1/admin/schema/capabilities")
    expect(api.ENDPOINTS.snapshot).toBe("/v1/admin/schema")
    expect(api.ENDPOINTS.history).toBe("/v1/admin/schema/history")
    for (const path of Object.values(api.ENDPOINTS)) {
      expect(typeof path === "string" ? FROZEN_PATHS.has(path) : true).toBe(
        true,
      )
    }
  })

  it("URL-encodes table detail identifiers", () => {
    const path = api.ENDPOINTS.tableDetail("my schema", "weird/table")
    expect(path).toBe("/v1/admin/schema/tables/my%20schema/weird%2Ftable")
    expect(path.startsWith("/v1/admin/schema/tables/")).toBe(true)
  })
})

describe("api.adminFetch", () => {
  it("resolves the envelope data and meta on success", async () => {
    const fetchImpl = async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("GET")
      expect(init.headers).toMatchObject({
        authorization: "Bearer op-token",
        accept: "application/json",
      })
      return jsonResponse(200, {
        data: { status: "ok" },
        meta: { limit: 50, offset: 0 },
      })
    }
    const result = await api.adminFetch("/v1/admin/schema", {
      getToken: () => "op-token",
      fetchImpl,
    })
    expect(result).toEqual({
      ok: true,
      data: { status: "ok" },
      meta: { limit: 50, offset: 0 },
    })
  })

  it("classifies 401 INVALID_CREDENTIALS and AUTH_REQUIRED", async () => {
    const rejected = await api.adminFetch("/v1/admin/schema", {
      getToken: () => "op-token",
      fetchImpl: async () =>
        jsonResponse(401, {
          data: null,
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid operator token",
          },
        }),
    })
    expect(rejected).toMatchObject({
      ok: false,
      status: 401,
      code: "INVALID_CREDENTIALS",
    })

    const required = await api.adminFetch("/v1/admin/schema", {
      getToken: () => "op-token",
      fetchImpl: async () =>
        jsonResponse(401, {
          data: null,
          error: { code: "AUTH_REQUIRED", message: "Authentication required" },
        }),
    })
    expect(required.code).toBe("AUTH_REQUIRED")
  })

  it("captures 429 Retry-After seconds", async () => {
    const result = await api.adminFetch("/v1/admin/schema", {
      getToken: () => "op-token",
      fetchImpl: async () =>
        jsonResponse(
          429,
          {
            data: null,
            error: { code: "RATE_LIMITED", message: "Rate limit exceeded" },
          },
          { "retry-after": "42" },
        ),
    })
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      retryAfter: 42,
    })
  })

  it("passes through frozen envelope codes for other failures", async () => {
    const result = await api.adminFetch("/v1/admin/schema", {
      getToken: () => "op-token",
      fetchImpl: async () =>
        jsonResponse(503, {
          data: null,
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database unavailable",
          },
        }),
    })
    expect(result).toMatchObject({ status: 503, code: "DATABASE_UNAVAILABLE" })
  })

  it("falls back to INTERNAL_ERROR for non-envelope error bodies", async () => {
    const result = await api.adminFetch("/v1/admin/schema", {
      getToken: () => "op-token",
      fetchImpl: async () =>
        new Response("<html>nope</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
    })
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      code: "INTERNAL_ERROR",
    })
  })

  it("maps network failures to a retryable status 0", async () => {
    const result = await api.adminFetch("/v1/admin/schema", {
      getToken: () => "op-token",
      fetchImpl: async () => {
        throw new Error("connection refused")
      },
    })
    expect(result).toMatchObject({
      ok: false,
      status: 0,
      code: "NETWORK_ERROR",
      retryAfter: null,
    })
  })

  it("maps aborts to the timeout message", async () => {
    const aborted = new Error("The operation was aborted")
    aborted.name = "AbortError"
    const result = await api.adminFetch("/v1/admin/schema", {
      getToken: () => "op-token",
      fetchImpl: async () => {
        throw aborted
      },
    })
    expect(result.code).toBe("NETWORK_ERROR")
    expect(result.message).toContain("did not respond in time")
  })

  it("refuses to call fetch without a token", async () => {
    let called = false
    const result = await api.adminFetch("/v1/admin/schema", {
      getToken: () => null,
      fetchImpl: async () => {
        called = true
        return jsonResponse(200, { data: null })
      },
    })
    expect(called).toBe(false)
    expect(result).toMatchObject({ ok: false, code: "AUTH_REQUIRED" })
  })
})

describe("api.createAdminClient", () => {
  it("drives the frozen surface against the shared in-memory token store", async () => {
    const seen: string[] = []
    const fetchImpl = async (url: string) => {
      seen.push(url)
      return jsonResponse(200, {
        data: { url },
        meta: { limit: 50, offset: 10 },
      })
    }
    const client = api.createAdminClient({
      getToken: () => tokenStore.getToken(),
      fetchImpl,
      timeoutMs: 1000,
    })

    tokenStore.setToken("op-token")
    try {
      await client.capabilities()
      await client.snapshot()
      await client.history(50, 10)
      await client.tableDetail("app", "todos")
    } finally {
      tokenStore.clearToken()
    }

    expect(seen).toEqual([
      "/v1/admin/schema/capabilities",
      "/v1/admin/schema",
      "/v1/admin/schema/history?limit=50&offset=10",
      "/v1/admin/schema/tables/app/todos",
    ])
  })
})
