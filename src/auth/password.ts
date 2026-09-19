// Password rules and Argon2id hashing (docs/auth-spec.md).

import argon2 from "argon2"

import { AuthError } from "./errors.js"

/** 19 MiB in kibibytes — argon2 memoryCost unit. */
export const ARGON2_MEMORY_COST_KIB = 19_456
export const ARGON2_TIME_COST = 2
export const ARGON2_PARALLELISM = 1

const MIN_PASSWORD_LENGTH = 10
const MAX_PASSWORD_LENGTH = 128

/**
 * Precomputed Argon2id hash (same params) used for timing-hardening when
 * login email is unknown. Password material is not secret.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$kOTS8pzolNLTAb0CEHTqTg$Sg/x646QMWXBKD91wdOVL//4pmIuoISl3hqOiDVzrVM"

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: ARGON2_MEMORY_COST_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
} as const

/** Unicode general category Cc (C0, DEL, and C1 controls). */
const UNICODE_CONTROL = /\p{Cc}/u

function passwordCodePointLength(password: string): number {
  return Array.from(password).length
}

export function validatePassword(password: string): void {
  const length = passwordCodePointLength(password)

  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw new AuthError("VALIDATION_ERROR", "Request validation failed", 400, {
      password: `Must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
    })
  }

  if (UNICODE_CONTROL.test(password)) {
    throw new AuthError("VALIDATION_ERROR", "Request validation failed", 400, {
      password: "Must not contain control characters",
    })
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS)
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password)
  } catch {
    return false
  }
}

/** Burn comparable Argon2id work when the user is unknown. */
export async function verifyDummyPassword(password: string): Promise<void> {
  try {
    await argon2.verify(DUMMY_PASSWORD_HASH, password)
  } catch {
    // Ignore verification/library failures; caller still throws INVALID_CREDENTIALS.
  }
}
