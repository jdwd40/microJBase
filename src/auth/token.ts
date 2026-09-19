// Opaque session tokens: 32 random bytes, base64url transport, SHA-256 digest.

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"

export const TOKEN_BYTE_LENGTH = 32

/** Unpadded base64url encoding of 32 bytes is always 43 characters. */
const TOKEN_TRANSPORT_LENGTH = 43
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

export type RandomBytesFn = (size: number) => Buffer

export function generateSessionToken(
  randomBytes: RandomBytesFn = nodeRandomBytes,
): { rawToken: string; tokenHash: Buffer } {
  const bytes = randomBytes(TOKEN_BYTE_LENGTH)
  if (bytes.length !== TOKEN_BYTE_LENGTH) {
    throw new Error("randomBytes must return exactly 32 bytes")
  }
  const rawToken = bytes.toString("base64url")
  const tokenHash = hashTokenBytes(bytes)
  return { rawToken, tokenHash }
}

export function hashTokenBytes(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest()
}

/**
 * Syntactic token validity: base64url alphabet, no padding, decodes to
 * exactly 32 bytes, and round-trips to the same transport form.
 */
export function parseRawToken(rawToken: string): Buffer | null {
  if (!TOKEN_SHAPE.test(rawToken)) {
    return null
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(rawToken, "base64url")
  } catch {
    return null
  }

  if (bytes.length !== TOKEN_BYTE_LENGTH) {
    return null
  }

  // Reject non-canonical encodings that still decode to 32 bytes.
  if (bytes.toString("base64url") !== rawToken) {
    return null
  }

  if (rawToken.length !== TOKEN_TRANSPORT_LENGTH) {
    return null
  }

  return bytes
}

export function hashRawToken(rawToken: string): Buffer | null {
  const bytes = parseRawToken(rawToken)
  if (bytes === null) {
    return null
  }
  return hashTokenBytes(bytes)
}
