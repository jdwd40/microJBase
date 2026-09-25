// Unit tests for the operator-token digest verification (V02-16, D-013).

import { createHash, randomBytes } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  decodeAdminTokenDigest,
  hashOperatorToken,
  verifyOperatorToken,
} from "../../../src/auth/index.js"

describe("hashOperatorToken", () => {
  it("returns the SHA-256 digest of the raw token", () => {
    const digest = hashOperatorToken("swordfish")
    const expected = createHash("sha256").update("swordfish", "utf8").digest()
    expect(digest.equals(expected)).toBe(true)
  })

  it("is deterministic and distinct per token", () => {
    const a = hashOperatorToken("token-a")
    const b = hashOperatorToken("token-b")
    expect(a.equals(b)).toBe(false)
    expect(hashOperatorToken("token-a").equals(a)).toBe(true)
  })
})

describe("decodeAdminTokenDigest", () => {
  it("decodes a valid 64-character lowercase hex digest", () => {
    const hex = createHash("sha256").update("x").digest("hex")
    const decoded = decodeAdminTokenDigest(hex)
    expect(decoded).not.toBeNull()
    expect(decoded?.length).toBe(32)
  })

  it("accepts uppercase input by normalising nothing (pattern is strict)", () => {
    const hex = createHash("sha256").update("x").digest("hex").toUpperCase()
    expect(decodeAdminTokenDigest(hex)).toBeNull()
  })

  it("rejects malformed digests", () => {
    expect(decodeAdminTokenDigest("")).toBeNull()
    expect(decodeAdminTokenDigest("zz".repeat(32))).toBeNull()
    expect(decodeAdminTokenDigest("ab".repeat(31))).toBeNull()
    expect(decodeAdminTokenDigest("ab".repeat(33))).toBeNull()
  })
})

describe("verifyOperatorToken", () => {
  const token = randomBytes(24).toString("base64url")
  const digest = hashOperatorToken(token)

  it("verifies the correct token", () => {
    expect(verifyOperatorToken(token, digest)).toBe(true)
  })

  it("rejects a wrong token of the same length class", () => {
    const other = randomBytes(24).toString("base64url")
    expect(verifyOperatorToken(other, digest)).toBe(false)
  })

  it("rejects an empty and a missing token", () => {
    expect(verifyOperatorToken("", digest)).toBe(false)
    expect(verifyOperatorToken(null, digest)).toBe(false)
  })

  it("rejects against an empty expected digest", () => {
    expect(verifyOperatorToken(token, Buffer.alloc(0))).toBe(false)
  })

  it("rejects without throwing on a differently-sized digest", () => {
    expect(verifyOperatorToken(token, Buffer.from([1, 2, 3]))).toBe(false)
  })

  it("treats an ordinary session-shaped token as a normal candidate", () => {
    // Ordinary session tokens are 32 random bytes, base64url. They must
    // simply fail verification, never reach admin handlers, and never throw.
    const sessionToken = randomBytes(32).toString("base64url")
    expect(verifyOperatorToken(sessionToken, digest)).toBe(false)
  })
})
