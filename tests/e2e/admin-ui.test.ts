// E2E acceptance for the management UI shell (I1, V02-17 client).
//
// Covers, against the real compiled server:
//
//  - lane gating (D-012): with the admin lane disabled the whole /admin
//    surface is a plain 404 with the public envelope — no fingerprint;
//  - serving: GET /admin redirects to /admin/, the shell and every asset are
//    served with no-store, the restrictive CSP, nosniff, no-referrer, and
//    same-origin isolation, with correct content types;
//  - shell hygiene: no inline scripts, no browser storage APIs anywhere in
//    the shipped client (the operator token is memory-only);
//  - contract drift guard: the only /v1/admin paths the client references are
//    the frozen V02-17 read endpoints — nothing invented, nothing extra;
//  - robustness: unknown assets and traversal attempts 404; static assets do
//    not consume the admin API rate budget; query strings do not weaken
//    no-store; the admin API itself stays behind operator auth.
//
// The shared API helper assumes JSON everywhere; the UI is HTML/CSS/JS, so
// this file uses a small raw fetch helper for UI requests.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { E2E_ADMIN_TOKEN } from "./helpers/config.js"
import { createApi, expectError, expectNoStore } from "./helpers/http.js"
import { startE2EFile, stopE2EFile } from "./helpers/lifecycle.js"
import { startE2EServer } from "./helpers/server.js"

const ASSETS = [
  "index.html",
  "styles.css",
  "app.js",
  "api.js",
  "format.js",
  "render.js",
  "view-models.js",
  "token-store.js",
] as const

// The exact V02-17 read surface the client may speak to (docs/admin-api.md).
// "/v1/admin/schema" is a prefix of the others and must stay last.
const FROZEN_ADMIN_PREFIXES = [
  "/v1/admin/schema/capabilities",
  "/v1/admin/schema/history",
  "/v1/admin/schema/tables/",
  "/v1/admin/schema",
] as const

interface RawResponse {
  status: number
  headers: Headers
  text: string
  body: unknown
}

let context: Awaited<ReturnType<typeof startE2EFile>>

beforeAll(async () => {
  context = await startE2EFile({ admin: true })
}, 180_000)

afterAll(async () => {
  await stopE2EFile(context)
})

async function rawGet(baseUrl: string, path: string): Promise<RawResponse> {
  // Manual redirect mode: GET /admin must answer 302 itself, not be followed.
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: response.status, headers: response.headers, text, body }
}

describe("admin lane disabled (no /admin fingerprint, D-012)", () => {
  it("returns the plain 404 envelope for the whole UI surface", async () => {
    const plain = await startE2EServer({})
    try {
      const api = createApi(plain.baseUrl)
      for (const path of ["/admin", "/admin/", "/admin/assets/app.js"]) {
        const response = await api.get(path)
        expectError(response, 404, "TABLE_NOT_FOUND")
        expectNoStore(response)
      }
      // Pre-route failures on the UI prefix carry no-store too.
      const post = await api.send("POST", "/admin/", "{}")
      expectError(post, 404, "TABLE_NOT_FOUND")
      expectNoStore(post)
    } finally {
      await plain.stop()
    }
  }, 60_000)
})

describe("shell serving", () => {
  it("redirects /admin to /admin/ and serves the shell HTML", async () => {
    const redirect = await rawGet(context.server.baseUrl, "/admin")
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("location")).toBe("/admin/")
    expectNoStore(redirect)

    const shell = await rawGet(context.server.baseUrl, "/admin/")
    expect(shell.status).toBe(200)
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expectNoStore(shell)
    expect(shell.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    )
    expect(shell.headers.get("x-content-type-options")).toBe("nosniff")
    expect(shell.headers.get("referrer-policy")).toBe("no-referrer")
    expect(shell.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    )

    const html = shell.text
    expect(html).toContain('lang="en"')
    expect(html).toContain('src="/admin/assets/app.js"')
    expect(html).toContain('href="/admin/assets/styles.css"')
    expect(html).toContain("<nav")
    expect(html).toContain("<main")
    // The login form itself is rendered client-side into this mount point.
    expect(html).toContain('id="login-content"')
    expect(html).toContain("Operator sign-in")
    // No inline script or style anywhere in the shell (CSP is exact).
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(html).not.toMatch(/<style/)
    expect(html).not.toMatch(/\sstyle="/)
  })

  it("keeps no-store on the UI prefix when a query string is present", async () => {
    const response = await rawGet(context.server.baseUrl, "/admin/?v=1")
    expect(response.status).toBe(200)
    expectNoStore(response)
  })

  it("serves every asset with the right type and headers", async () => {
    for (const name of ASSETS) {
      const response = await rawGet(
        context.server.baseUrl,
        `/admin/assets/${name}`,
      )
      expect(response.status).toBe(200)
      const expected = name.endsWith(".html")
        ? "text/html; charset=utf-8"
        : name.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8"
      expect(response.headers.get("content-type")).toBe(expected)
      expectNoStore(response)
      expect(response.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      )
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
  })

  it("404s unknown assets and refuses traversal", async () => {
    const unknown = await rawGet(
      context.server.baseUrl,
      "/admin/assets/nope.js",
    )
    expectError(asApi(unknown), 404, "TABLE_NOT_FOUND")

    const traversal = await rawGet(
      context.server.baseUrl,
      "/admin/assets/..%2F..%2Fpackage.json",
    )
    expect(traversal.status).not.toBe(200)

    const nested = await rawGet(
      context.server.baseUrl,
      "/admin/assets/js/app.js",
    )
    expectError(asApi(nested), 404, "TABLE_NOT_FOUND")
  })

  it("serves static assets without consuming the admin API rate budget", async () => {
    for (let i = 0; i < 40; i += 1) {
      const response = await rawGet(
        context.server.baseUrl,
        "/admin/assets/app.js",
      )
      expect(response.status).toBe(200)
    }
    // The API tree itself is still intact and guarded.
    const unauthenticated = await context.api.get("/v1/admin/schema")
    expectError(unauthenticated, 401, "AUTH_REQUIRED")
    const authenticated = await context.api.get(
      "/v1/admin/schema/capabilities",
      E2E_ADMIN_TOKEN,
    )
    expect(authenticated.status).toBe(200)
  })
})

describe("client contract hygiene", () => {
  it("references only the frozen V02-17 read endpoints", async () => {
    let clientSource = ""
    for (const name of ASSETS) {
      if (name.endsWith(".js")) {
        const response = await rawGet(
          context.server.baseUrl,
          `/admin/assets/${name}`,
        )
        clientSource += `\n// ${name}\n${response.text}`
      }
    }
    const referenced =
      clientSource.match(/\/v1\/admin\/[A-Za-z0-9_/${}.-]*/g) ?? []
    expect(referenced.length).toBeGreaterThan(0)
    for (const path of referenced) {
      const known = FROZEN_ADMIN_PREFIXES.some((prefix) =>
        path.startsWith(prefix),
      )
      expect(known, `client references non-frozen path ${path}`).toBe(true)
    }
  })

  it("never accesses browser storage APIs", async () => {
    for (const name of ASSETS) {
      const response = await rawGet(
        context.server.baseUrl,
        `/admin/assets/${name}`,
      )
      // Usage patterns, not prose: the token-store source documents the
      // invariant by naming the surfaces it must never touch.
      expect(response.text).not.toMatch(/\blocalStorage\s*[.[]/)
      expect(response.text).not.toMatch(/\bsessionStorage\s*[.[]/)
      expect(response.text).not.toMatch(/\bdocument\s*\.\s*cookie\b/)
    }
  })
})

/** expectError is typed against ApiResponse; RawResponse is structurally identical. */
function asApi(response: RawResponse): Parameters<typeof expectError>[0] {
  return response
}
