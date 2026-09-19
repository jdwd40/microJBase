import { describe, expect, it } from "vitest"

import { buildServer } from "../../src/main.js"

// Placeholder smoke test proving the unit toolchain (Vitest + TypeScript
// strict imports) works. Real unit suites arrive with each module PR.
describe("toolchain smoke (unit)", () => {
  it("imports the composition root under strict TypeScript", () => {
    expect(typeof buildServer).toBe("function")
  })
})
