// Email normalisation and pragmatic validation (docs/auth-spec.md).

import { AuthError } from "./errors.js"

const MAX_EMAIL_UTF8_BYTES = 254

/** ASCII whitespace only: HT, LF, VT, FF, CR, SPACE. */
const ASCII_WHITESPACE_TRIM = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g

/**
 * Pragmatic address shape after normalisation:
 * - exactly one `@`
 * - non-empty local and domain
 * - domain contains at least one `.`
 * - no ASCII whitespace inside the address
 */
const PRAGMATIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** Unicode general category Cc (C0, DEL, and C1 controls). */
const UNICODE_CONTROL = /\p{Cc}/u

export function normaliseEmail(raw: string): string {
  const trimmed = raw.replace(ASCII_WHITESPACE_TRIM, "")
  const nfc = trimmed.normalize("NFC")
  const email = nfc.toLowerCase()

  if (
    email.length === 0 ||
    Buffer.byteLength(email, "utf8") > MAX_EMAIL_UTF8_BYTES ||
    UNICODE_CONTROL.test(email) ||
    !PRAGMATIC_EMAIL.test(email)
  ) {
    throw new AuthError("VALIDATION_ERROR", "Request validation failed", 400, {
      email: "Must be a valid email address",
    })
  }

  return email
}
