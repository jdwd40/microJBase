import { describe, expect, it } from "vitest"

import {
  ARGON2_MEMORY_COST_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  AuthError,
  hashPassword,
  validatePassword,
  verifyPassword,
} from "../../../src/auth/index.js"

describe("validatePassword", () => {
  it("accepts passwords between 10 and 128 characters without transforming", () => {
    const password = "  correct horse  " // leading spaces preserved by caller; length 17
    expect(() => validatePassword(password)).not.toThrow()
    expect(password).toBe("  correct horse  ")
  })

  it("accepts exact 10 and 128 Unicode code-point boundaries", () => {
    expect(() => validatePassword("a".repeat(10))).not.toThrow()
    expect(() => validatePassword("a".repeat(128))).not.toThrow()
    // 128 BMP code points + one emoji (U+1F600) is 129 code points
    expect(() => validatePassword("a".repeat(127) + "😀")).not.toThrow()
    expect(() => validatePassword("a".repeat(128) + "😀")).toThrow(AuthError)
  })

  it("counts Unicode code points, not UTF-16 code units", () => {
    // Five emoji: 5 code points, 10 UTF-16 units — must reject as too short
    expect(() => validatePassword("😀😀😀😀😀")).toThrow(AuthError)
    try {
      validatePassword("😀😀😀😀😀")
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("VALIDATION_ERROR")
      expect(authError.details).toHaveProperty("password")
    }

    // Ten emoji meet the minimum by code points
    expect(() => validatePassword("😀😀😀😀😀😀😀😀😀😀")).not.toThrow()
  })

  it("rejects too short and too long passwords", () => {
    expect(() => validatePassword("short")).toThrow(AuthError)
    expect(() => validatePassword("a".repeat(129))).toThrow(AuthError)
    try {
      validatePassword("short")
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("VALIDATION_ERROR")
      expect(authError.details).toHaveProperty("password")
      expect(JSON.stringify(authError)).not.toContain("short")
    }
  })

  it("rejects C0, DEL, and C1 control characters including NUL", () => {
    expect(() => validatePassword("password\0xx")).toThrow(AuthError)
    expect(() => validatePassword("password\nxx!")).toThrow(AuthError)
    expect(() => validatePassword("password\u007f!!")).toThrow(AuthError)
    // C1 control U+0085 (NEXT LINE) — previously accepted
    expect(() => validatePassword("abcdefghij\u0085")).toThrow(AuthError)
    expect(() => validatePassword("abcdefghij\u009f")).toThrow(AuthError)
  })
})

describe("hashPassword / verifyPassword", () => {
  it("round-trips and embeds explicit Argon2id parameters", async () => {
    const password = "correct horse battery staple"
    const hash = await hashPassword(password)
    expect(hash.startsWith("$argon2id$")).toBe(true)
    expect(hash).toContain(`m=${ARGON2_MEMORY_COST_KIB}`)
    expect(hash).toContain(`t=${ARGON2_TIME_COST}`)
    expect(hash).toContain(`p=${ARGON2_PARALLELISM}`)
    expect(await verifyPassword(hash, password)).toBe(true)
    expect(await verifyPassword(hash, "wrong password!!")).toBe(false)
  })
})
