// E2E session expiry: a dedicated server instance with SESSION_TTL_SECONDS=1
// proves expired tokens are rejected on /me and data routes while logout
// remains a quiet 204.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { expectError, registerUser } from "./helpers/http.js"
import {
  startE2EFile,
  stopE2EFile,
  type E2EContext,
} from "./helpers/lifecycle.js"

describe("e2e session expiry", () => {
  let ctx: E2EContext

  beforeAll(async () => {
    ctx = await startE2EFile({ sessionTtlSeconds: 1 })
  })

  afterAll(async () => {
    await stopE2EFile(ctx)
  })

  it("rejects an expired token on /me and data routes but logout stays 204", async () => {
    const { token } = await registerUser(
      ctx.api,
      `heidi-${ctx.run}@example.test`,
    )

    // Valid immediately after issue.
    const fresh = await ctx.api.get("/v1/auth/me", token)
    expect(fresh.status).toBe(200)

    // SESSION_TTL_SECONDS=1; two seconds is safely past expiry even on a
    // loaded CI worker. Session resolution compares expires_at > now().
    await new Promise((resolve) => setTimeout(resolve, 2_000))

    const me = await ctx.api.get("/v1/auth/me", token)
    expectError(me, 401, "AUTH_REQUIRED")

    const data = await ctx.api.get("/v1/data/todos", token)
    expectError(data, 401, "AUTH_REQUIRED")

    // Expired-token logout is still a quiet 204 (spec: unknown, expired, or
    // already-revoked but validly shaped tokens return 204).
    const logout = await ctx.api.post("/v1/auth/logout", {}, token)
    expect(logout.status).toBe(204)
  })
})
