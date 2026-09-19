import { describe, expect, it } from "vitest"

import { AuthError, normaliseEmail } from "../../../src/auth/index.js"

describe("normaliseEmail", () => {
  it("trims ASCII whitespace, NFC-normalises, and lowercases", () => {
    // Café with combining accent → NFC, then lowercased
    const decomposed = "  CAF\u0045\u0301@Example.COM\t"
    expect(normaliseEmail(decomposed)).toBe("caf\u00e9@example.com")
  })

  it("does not trim non-ASCII Unicode spaces", () => {
    // NBSP is not ASCII whitespace — address becomes invalid after lowercase
    expect(() => normaliseEmail("\u00a0a@b.co")).toThrow(AuthError)
  })

  it("accepts a simple valid address", () => {
    expect(normaliseEmail("alice@example.com")).toBe("alice@example.com")
  })

  it("rejects missing @, empty local/domain, and missing dot in domain", () => {
    const cases = [
      "",
      "   ",
      "no-at",
      "@example.com",
      "alice@",
      "alice@localhost",
    ]
    for (const value of cases) {
      try {
        normaliseEmail(value)
        expect.fail(`expected rejection for ${JSON.stringify(value)}`)
      } catch (error) {
        expect(error).toBeInstanceOf(AuthError)
        const authError = error as AuthError
        expect(authError.code).toBe("VALIDATION_ERROR")
        expect(authError.status).toBe(400)
        expect(authError.details).toEqual({
          email: "Must be a valid email address",
        })
      }
    }
  })

  it("rejects control characters in the local or domain part", () => {
    // NUL and ESC previously matched [^\s@]+
    expect(() => normaliseEmail("a\u0000@b.co")).toThrow(AuthError)
    expect(() => normaliseEmail("a\u001b@b.co")).toThrow(AuthError)
    // C1 control
    expect(() => normaliseEmail("a\u0085@b.co")).toThrow(AuthError)
    expect(() => normaliseEmail("alice@ex\u007fample.com")).toThrow(AuthError)
  })

  it("rejects addresses longer than 254 UTF-8 bytes", () => {
    const local = "a".repeat(250)
    const email = `${local}@example.com` // > 254 bytes
    expect(Buffer.byteLength(email, "utf8")).toBeGreaterThan(254)
    expect(() => normaliseEmail(email)).toThrow(AuthError)
  })
})
