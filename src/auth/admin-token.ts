// Operator-token verification for the opt-in admin lane (D-013).
//
// The operator presents `Authorization: Bearer <token>`; the configured
// `MICROJBASE_ADMIN_TOKEN_SHA256` is the SHA-256 hex digest of that token.
// Verification hashes the presented token and compares digests with
// `timingSafeEqual` so the comparison itself leaks no prefix information.
// The raw token is never stored, logged, or echoed; only its digest crosses
// this boundary, and only as the operator-supplied configuration value.

import { createHash, timingSafeEqual } from "node:crypto"

/** SHA-256 digest of a raw operator token. */
export function hashOperatorToken(rawToken: string): Buffer {
  return createHash("sha256").update(rawToken, "utf8").digest()
}

/**
 * Decode the configured digest (64 lowercase hex characters) into bytes.
 * Returns null when the value is not exactly 32 bytes of hex; parseConfig
 * rejects malformed values at startup, so null here means a programming
 * error, and verification then fails closed.
 */
export function decodeAdminTokenDigest(hexDigest: string): Buffer | null {
  if (!/^[0-9a-f]{64}$/.test(hexDigest)) {
    return null
  }
  return Buffer.from(hexDigest, "hex")
}

/**
 * Constant-time verification of a presented operator token against the
 * configured digest. A missing token never verifies; the digest comparison
 * runs in constant time and never throws on length mismatch.
 */
export function verifyOperatorToken(
  rawToken: string | null,
  expectedDigest: Buffer,
): boolean {
  if (rawToken === null || expectedDigest.length === 0) {
    return false
  }
  const actual = hashOperatorToken(rawToken)
  if (actual.length !== expectedDigest.length) {
    return false
  }
  return timingSafeEqual(actual, expectedDigest)
}
