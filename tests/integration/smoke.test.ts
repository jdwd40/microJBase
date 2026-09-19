import pg from "pg"
import { describe, expect, it } from "vitest"

// Placeholder smoke test proving the integration toolchain works and the
// PostgreSQL client dependency is installed. Real integration tests against
// a live PostgreSQL service arrive with the database PRs.
describe("toolchain smoke (integration)", () => {
  it("loads the pg client dependency", () => {
    expect(typeof pg.Client).toBe("function")
  })
})
