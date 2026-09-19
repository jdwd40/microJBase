import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  generateSessionToken,
  hashRawToken,
  hashTokenBytes,
  parseRawToken,
  TOKEN_BYTE_LENGTH,
} from "../../../src/auth/index.js"

describe("session tokens", () => {
  it("produces 32-byte base64url tokens and SHA-256 digests of the raw bytes", () => {
    const fixed = Buffer.alloc(TOKEN_BYTE_LENGTH, 7)
    const { rawToken, tokenHash } = generateSessionToken(() => fixed)

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(rawToken, "base64url")).toEqual(fixed)
    expect(tokenHash).toEqual(createHash("sha256").update(fixed).digest())
    expect(tokenHash).toEqual(hashTokenBytes(fixed))
    expect(hashRawToken(rawToken)).toEqual(tokenHash)
  })

  it("parseRawToken accepts only canonical 32-byte base64url", () => {
    const { rawToken } = generateSessionToken()
    expect(parseRawToken(rawToken)?.length).toBe(32)
    expect(parseRawToken("")).toBeNull()
    expect(parseRawToken("not-a-token")).toBeNull()
    expect(parseRawToken(rawToken + "=")).toBeNull()
    expect(parseRawToken("a".repeat(43))).toBeNull()
  })

  it("hashRawToken returns null for malformed tokens", () => {
    expect(hashRawToken("@@@")).toBeNull()
    expect(hashRawToken("")).toBeNull()
  })
})
