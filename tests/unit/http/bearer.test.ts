import { describe, expect, it } from "vitest"

import { extractBearerToken } from "../../../src/http/bearer.js"

describe("extractBearerToken", () => {
  it("returns the token for a valid Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123")
  })

  it("is case-insensitive on the Bearer word only", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123")
    expect(extractBearerToken("BEARER abc123")).toBeNull()
  })

  it("returns null when the header is undefined", () => {
    expect(extractBearerToken(undefined)).toBeNull()
  })

  it("returns null when the header is empty", () => {
    expect(extractBearerToken("")).toBeNull()
  })

  it("returns null for missing token", () => {
    expect(extractBearerToken("Bearer ")).toBeNull()
    expect(extractBearerToken("Bearer")).toBeNull()
  })

  it("returns null for non-Bearer schemes", () => {
    expect(extractBearerToken("Basic abc123")).toBeNull()
    expect(extractBearerToken("Token abc123")).toBeNull()
  })

  it("returns null for arrays with more than one value", () => {
    expect(extractBearerToken(["Bearer a", "Bearer b"])).toBeNull()
  })

  it("returns the token from a single-element array", () => {
    expect(extractBearerToken(["Bearer abc123"])).toBe("abc123")
  })
})
