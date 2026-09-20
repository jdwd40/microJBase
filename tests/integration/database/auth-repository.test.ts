import { randomBytes } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { AppError } from "../../../src/core/index.js"
import {
  createAuthRepository,
  createPool,
  type Pool,
} from "../../../src/database/index.js"
import type { AuthRepository } from "../../../src/contracts/index.js"
import { applyMigrationsAndGrants, withClient } from "./bootstrap.js"

const databaseUrl = process.env.INTEGRATION_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "INTEGRATION_DATABASE_URL environment variable is required for integration tests",
  )
}

const adminDatabaseUrl = process.env.INTEGRATION_ADMIN_DATABASE_URL
if (!adminDatabaseUrl) {
  throw new Error(
    "INTEGRATION_ADMIN_DATABASE_URL environment variable is required for auth repository tests",
  )
}

const RUNTIME_ROLE_NAME = "microjbase_runtime"

function tokenHash(seed?: string): Buffer {
  if (seed !== undefined) {
    return Buffer.from(seed.padEnd(32, "0").slice(0, 32))
  }
  return randomBytes(32)
}

function futureExpiry(days = 7): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

function pastExpiry(): Date {
  return new Date(Date.now() - 60_000)
}

async function countUsers(adminUrl: string, email?: string): Promise<number> {
  return withClient(adminUrl, async (client) => {
    if (email !== undefined) {
      const rs = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM microjbase.users WHERE email = $1`,
        [email],
      )
      return Number(rs.rows[0]?.count ?? 0)
    }
    const rs = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM microjbase.users`,
    )
    return Number(rs.rows[0]?.count ?? 0)
  })
}

async function countSessions(
  adminUrl: string,
  userId?: string,
): Promise<number> {
  return withClient(adminUrl, async (client) => {
    if (userId !== undefined) {
      const rs = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM microjbase.sessions WHERE user_id = $1`,
        [userId],
      )
      return Number(rs.rows[0]?.count ?? 0)
    }
    const rs = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM microjbase.sessions`,
    )
    return Number(rs.rows[0]?.count ?? 0)
  })
}

function assertSecretsAbsent(
  error: unknown,
  ...secrets: Array<string | Buffer>
): void {
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error))
  for (const secret of secrets) {
    const needle = Buffer.isBuffer(secret)
      ? secret.toString("hex")
      : String(secret)
    expect(serialized).not.toContain(needle)
    if (Buffer.isBuffer(secret)) {
      expect(serialized).not.toContain(secret.toString("base64"))
    }
  }
  expect(serialized).not.toContain("password_hash")
  expect(serialized).not.toContain("token_hash")
  expect(serialized).not.toContain(databaseUrl)
  expect(serialized).not.toContain(adminDatabaseUrl)
  expect(serialized).not.toMatch(/users_email_key|microjbase_dev_password/i)
}

describe("AuthRepository PostgreSQL adapter", () => {
  let pool: Pool
  let repo: AuthRepository

  beforeAll(async () => {
    await applyMigrationsAndGrants(adminDatabaseUrl, RUNTIME_ROLE_NAME)
    pool = createPool({ databaseUrl, maxConnections: 5 })
    repo = createAuthRepository(pool)
  })

  afterAll(async () => {
    await pool.close()
  })

  beforeEach(async () => {
    await withClient(adminDatabaseUrl, async (client) => {
      await client.query(`DELETE FROM microjbase.sessions`)
      await client.query(`DELETE FROM microjbase.users`)
      // Ensure no leftover fail-session constraint from a previous aborted test.
      await client.query(
        `ALTER TABLE microjbase.sessions DROP CONSTRAINT IF EXISTS sessions_fail_insert`,
      )
      // Disposable unique index used by unrelated-23505 classification test.
      await client.query(
        `DROP INDEX IF EXISTS microjbase.users_password_hash_unique_probe`,
      )
      // Identity-probe triggers/functions from microjbase.user_id regression.
      await client.query(
        `DROP TRIGGER IF EXISTS trg_reject_user_id_on_users ON microjbase.users`,
      )
      await client.query(
        `DROP TRIGGER IF EXISTS trg_reject_user_id_on_sessions ON microjbase.sessions`,
      )
      await client.query(
        `DROP FUNCTION IF EXISTS microjbase.reject_if_user_id_set()`,
      )
    })
  })

  it("creates a user and initial session successfully", async () => {
    const hash = tokenHash("success-token-hash-aaaaaaaa")
    const expiresAt = futureExpiry()
    const passwordHash = "$argon2id$v=19$m=19456,t=2,p=1$saltsaltsalt$hashhash"

    const { user, session } = await repo.createUserAndSession({
      email: "alice@example.com",
      passwordHash,
      tokenHash: hash,
      expiresAt,
    })

    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(user.email).toBe("alice@example.com")
    expect(user.createdAt).toBeInstanceOf(Date)

    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(session.userId).toBe(user.id)
    expect(Buffer.compare(session.tokenHash, hash)).toBe(0)
    expect(session.expiresAt.getTime()).toBe(expiresAt.getTime())
    expect(session.createdAt).toBeInstanceOf(Date)
    expect(session.revokedAt).toBeNull()
  })

  it("persists both user and session after successful registration (atomicity)", async () => {
    const hash = tokenHash("atomic-ok-token-hash-bbbbbbbb")
    const { user } = await repo.createUserAndSession({
      email: "atomic@example.com",
      passwordHash: "phash-atomic",
      tokenHash: hash,
      expiresAt: futureExpiry(),
    })

    expect(await countUsers(adminDatabaseUrl, "atomic@example.com")).toBe(1)
    expect(await countSessions(adminDatabaseUrl, user.id)).toBe(1)
  })

  it("translates duplicate email to EMAIL_ALREADY_REGISTERED", async () => {
    const input = {
      email: "dup@example.com",
      passwordHash: "phash-first",
      tokenHash: tokenHash("dup-first-token-hash-cccccccc"),
      expiresAt: futureExpiry(),
    }
    await repo.createUserAndSession(input)

    let caught: unknown
    try {
      await repo.createUserAndSession({
        ...input,
        passwordHash: "phash-second-SECRET",
        tokenHash: tokenHash("dup-second-token-hash-dddddddd"),
      })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AppError)
    expect(caught).toMatchObject({
      code: "EMAIL_ALREADY_REGISTERED",
      message: "Email already registered",
      status: 409,
    })
    assertSecretsAbsent(
      caught,
      "phash-second-SECRET",
      "phash-first",
      tokenHash("dup-second-token-hash-dddddddd"),
    )
    expect(await countUsers(adminDatabaseUrl, "dup@example.com")).toBe(1)
  })

  it("handles racing duplicate registration (one success, one EMAIL_ALREADY_REGISTERED)", async () => {
    const email = "race@example.com"
    const results = await Promise.allSettled([
      repo.createUserAndSession({
        email,
        passwordHash: "phash-race-a",
        tokenHash: tokenHash("race-token-a-eeeeeeeeeeeeeeee"),
        expiresAt: futureExpiry(),
      }),
      repo.createUserAndSession({
        email,
        passwordHash: "phash-race-b",
        tokenHash: tokenHash("race-token-b-ffffffffffffffff"),
        expiresAt: futureExpiry(),
      }),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "EMAIL_ALREADY_REGISTERED",
        message: "Email already registered",
        status: 409,
      }),
    })
    expect(await countUsers(adminDatabaseUrl, email)).toBe(1)
  })

  it("rolls back the user when session insert fails (CHECK constraint)", async () => {
    // Force session inserts to fail so the registration transaction must
    // roll back the user row as well. Constraint is added via admin and
    // removed in finally so other tests stay isolated.
    await withClient(adminDatabaseUrl, async (client) => {
      await client.query(
        `ALTER TABLE microjbase.sessions
         ADD CONSTRAINT sessions_fail_insert CHECK (false)`,
      )
    })

    const email = "rollback@example.com"
    const hash = tokenHash("rollback-token-hash-gggggggg")
    let caught: unknown
    try {
      await repo.createUserAndSession({
        email,
        passwordHash: "phash-rollback-SECRET",
        tokenHash: hash,
        expiresAt: futureExpiry(),
      })
    } catch (error: unknown) {
      caught = error
    } finally {
      await withClient(adminDatabaseUrl, async (client) => {
        await client.query(
          `ALTER TABLE microjbase.sessions
           DROP CONSTRAINT IF EXISTS sessions_fail_insert`,
        )
      })
    }

    expect(caught).toBeDefined()
    expect(caught).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "An unexpected database error occurred",
      status: 500,
    })
    assertSecretsAbsent(caught, "phash-rollback-SECRET", hash, email)

    expect(await countUsers(adminDatabaseUrl, email)).toBe(0)
    expect(await countSessions(adminDatabaseUrl)).toBe(0)
  })

  it("leaves no partial session after a rolled-back registration", async () => {
    await withClient(adminDatabaseUrl, async (client) => {
      await client.query(
        `ALTER TABLE microjbase.sessions
         ADD CONSTRAINT sessions_fail_insert CHECK (false)`,
      )
    })

    try {
      await expect(
        repo.createUserAndSession({
          email: "partial@example.com",
          passwordHash: "phash-partial",
          tokenHash: tokenHash("partial-token-hash-hhhhhhhh"),
          expiresAt: futureExpiry(),
        }),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" })
    } finally {
      await withClient(adminDatabaseUrl, async (client) => {
        await client.query(
          `ALTER TABLE microjbase.sessions
           DROP CONSTRAINT IF EXISTS sessions_fail_insert`,
        )
      })
    }

    expect(await countUsers(adminDatabaseUrl)).toBe(0)
    expect(await countSessions(adminDatabaseUrl)).toBe(0)
  })

  it("looks up a user by email including password hash", async () => {
    const passwordHash = "phash-lookup-value"
    await repo.createUserAndSession({
      email: "lookup@example.com",
      passwordHash,
      tokenHash: tokenHash("lookup-token-hash-iiiiiiii"),
      expiresAt: futureExpiry(),
    })

    const found = await repo.findByEmail("lookup@example.com")
    expect(found).not.toBeNull()
    expect(found?.email).toBe("lookup@example.com")
    expect(found?.passwordHash).toBe(passwordHash)
    expect(found?.id).toBeTruthy()
    expect(found?.createdAt).toBeInstanceOf(Date)

    expect(await repo.findByEmail("missing@example.com")).toBeNull()
  })

  it("creates an additional session for an existing user", async () => {
    const { user } = await repo.createUserAndSession({
      email: "session@example.com",
      passwordHash: "phash-session",
      tokenHash: tokenHash("session-initial-hash-jjjjjjjj"),
      expiresAt: futureExpiry(),
    })

    const extraHash = tokenHash("session-extra-hash-kkkkkkkk")
    const expiresAt = futureExpiry(3)
    const session = await repo.createSession({
      userId: user.id,
      tokenHash: extraHash,
      expiresAt,
    })

    expect(session.userId).toBe(user.id)
    expect(Buffer.compare(session.tokenHash, extraHash)).toBe(0)
    expect(session.expiresAt.getTime()).toBe(expiresAt.getTime())
    expect(session.revokedAt).toBeNull()
    expect(await countSessions(adminDatabaseUrl, user.id)).toBe(2)
  })

  it("resolves an active session to the authenticated user", async () => {
    const hash = tokenHash("active-token-hash-llllllllllll")
    const { user } = await repo.createUserAndSession({
      email: "active@example.com",
      passwordHash: "phash-active",
      tokenHash: hash,
      expiresAt: futureExpiry(),
    })

    const authenticated = await repo.findActiveUserByTokenHash(hash, new Date())
    expect(authenticated).toEqual({ id: user.id, email: user.email })
  })

  it("returns null for an expired session", async () => {
    const hash = tokenHash("expired-token-hash-mmmmmmmm")
    await repo.createUserAndSession({
      email: "expired@example.com",
      passwordHash: "phash-expired",
      tokenHash: hash,
      expiresAt: pastExpiry(),
    })

    expect(await repo.findActiveUserByTokenHash(hash, new Date())).toBeNull()
  })

  it("returns null for a revoked session", async () => {
    const hash = tokenHash("revoked-token-hash-nnnnnnnn")
    await repo.createUserAndSession({
      email: "revoked@example.com",
      passwordHash: "phash-revoked",
      tokenHash: hash,
      expiresAt: futureExpiry(),
    })

    const revoked = await repo.revokeByTokenHash(hash, new Date())
    expect(revoked).toBe(true)
    expect(await repo.findActiveUserByTokenHash(hash, new Date())).toBeNull()
  })

  it("returns null when the token hash is missing", async () => {
    expect(
      await repo.findActiveUserByTokenHash(
        tokenHash("missing-token-hash-oooooooo"),
        new Date(),
      ),
    ).toBeNull()
  })

  it("cascades session deletion when the user is deleted", async () => {
    const hash = tokenHash("cascade-token-hash-pppppppp")
    const { user } = await repo.createUserAndSession({
      email: "cascade@example.com",
      passwordHash: "phash-cascade",
      tokenHash: hash,
      expiresAt: futureExpiry(),
    })

    await withClient(adminDatabaseUrl, async (client) => {
      await client.query(`DELETE FROM microjbase.users WHERE id = $1`, [
        user.id,
      ])
    })

    expect(await countSessions(adminDatabaseUrl, user.id)).toBe(0)
    expect(await repo.findActiveUserByTokenHash(hash, new Date())).toBeNull()
    expect(await repo.findByEmail("cascade@example.com")).toBeNull()
  })

  it("revokes idempotently and only the matching token", async () => {
    const hashA = tokenHash("revoke-a-token-hash-qqqqqqqq")
    const hashB = tokenHash("revoke-b-token-hash-rrrrrrrr")
    const { user } = await repo.createUserAndSession({
      email: "multi@example.com",
      passwordHash: "phash-multi",
      tokenHash: hashA,
      expiresAt: futureExpiry(),
    })
    await repo.createSession({
      userId: user.id,
      tokenHash: hashB,
      expiresAt: futureExpiry(),
    })

    const first = await repo.revokeByTokenHash(hashA, new Date())
    const second = await repo.revokeByTokenHash(hashA, new Date())
    expect(first).toBe(true)
    expect(second).toBe(false)

    expect(await repo.findActiveUserByTokenHash(hashA, new Date())).toBeNull()
    expect(await repo.findActiveUserByTokenHash(hashB, new Date())).toEqual({
      id: user.id,
      email: "multi@example.com",
    })
  })

  it("translates unexpected database errors safely", async () => {
    const closedPool = createPool({ databaseUrl, maxConnections: 1 })
    const closedRepo = createAuthRepository(closedPool)
    await closedPool.close()

    let caught: unknown
    try {
      await closedRepo.findByEmail("anything@example.com")
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toMatchObject({
      code: expect.stringMatching(/^(INTERNAL_ERROR|DATABASE_UNAVAILABLE)$/),
    })
    assertSecretsAbsent(caught)
  })

  it("never leaks secrets or constraint names on unique violation", async () => {
    const passwordHash = "super-secret-password-hash-value"
    const hash = tokenHash("secret-token-hash-ssssssssssss")
    await repo.createUserAndSession({
      email: "secret@example.com",
      passwordHash,
      tokenHash: hash,
      expiresAt: futureExpiry(),
    })

    let caught: unknown
    try {
      await repo.createUserAndSession({
        email: "secret@example.com",
        passwordHash,
        tokenHash: tokenHash("secret-token-hash-2-tttttttt"),
        expiresAt: futureExpiry(),
      })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toMatchObject({
      code: "EMAIL_ALREADY_REGISTERED",
      message: "Email already registered",
      status: 409,
    })
    assertSecretsAbsent(caught, passwordHash, hash)
    const serialized = JSON.stringify(
      caught,
      Object.getOwnPropertyNames(caught as object),
    )
    expect(serialized).not.toContain("23505")
    expect(serialized).not.toContain("users_email")
    expect(serialized).not.toMatch(/duplicate key|unique constraint/i)
  })

  it("does not map an unrelated 23505 to EMAIL_ALREADY_REGISTERED", async () => {
    // Disposable UNIQUE on password_hash so two different emails with the
    // same passwordHash collide on a non-email constraint.
    await withClient(adminDatabaseUrl, async (client) => {
      await client.query(
        `CREATE UNIQUE INDEX users_password_hash_unique_probe
         ON microjbase.users (password_hash)`,
      )
    })

    const sharedPasswordHash = "shared-password-hash-for-unrelated-23505"
    const firstHash = tokenHash("unrelated-23505-first-hash-uuuu")
    const secondHash = tokenHash("unrelated-23505-second-hash-vvvv")

    try {
      await repo.createUserAndSession({
        email: "unrelated-a@example.com",
        passwordHash: sharedPasswordHash,
        tokenHash: firstHash,
        expiresAt: futureExpiry(),
      })

      let caught: unknown
      try {
        await repo.createUserAndSession({
          email: "unrelated-b@example.com",
          passwordHash: sharedPasswordHash,
          tokenHash: secondHash,
          expiresAt: futureExpiry(),
        })
      } catch (error: unknown) {
        caught = error
      }

      expect(caught).toBeInstanceOf(AppError)
      expect(caught).toMatchObject({
        code: "INTERNAL_ERROR",
        message: "An unexpected database error occurred",
        status: 500,
      })
      expect(caught).not.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" })

      const serialized = JSON.stringify(
        caught,
        Object.getOwnPropertyNames(caught as object),
      )
      expect(serialized).not.toContain("23505")
      expect(serialized).not.toContain("users_password_hash_unique_probe")
      expect(serialized).not.toContain("users_email_key")
      expect(serialized).not.toContain(sharedPasswordHash)
      expect(serialized).not.toMatch(
        /duplicate key|unique constraint|password_hash/i,
      )
      assertSecretsAbsent(caught, sharedPasswordHash, firstHash, secondHash)

      expect(
        await countUsers(adminDatabaseUrl, "unrelated-a@example.com"),
      ).toBe(1)
      expect(
        await countUsers(adminDatabaseUrl, "unrelated-b@example.com"),
      ).toBe(0)
    } finally {
      await withClient(adminDatabaseUrl, async (client) => {
        await client.query(
          `DROP INDEX IF EXISTS microjbase.users_password_hash_unique_probe`,
        )
      })
    }
  })

  it("enforces UNIQUE token_hash at the database (duplicate session rejected)", async () => {
    const hashX = tokenHash("unique-token-hash-xxxxxxxxxxxxxxxx")
    const { user, session } = await repo.createUserAndSession({
      email: "tokuniq@example.com",
      passwordHash: "phash-tokuniq",
      tokenHash: hashX,
      expiresAt: futureExpiry(),
    })

    let caught: unknown
    try {
      await repo.createSession({
        userId: user.id,
        tokenHash: hashX,
        expiresAt: futureExpiry(),
      })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AppError)
    expect(caught).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "An unexpected database error occurred",
      status: 500,
    })
    const serialized = JSON.stringify(
      caught,
      Object.getOwnPropertyNames(caught as object),
    )
    expect(serialized).not.toContain("23505")
    expect(serialized).not.toContain("sessions_token_hash_key")
    expect(serialized).not.toMatch(/duplicate key|unique constraint/i)
    assertSecretsAbsent(caught, hashX)

    // First session intact; findActive still returns original user.
    const authenticated = await repo.findActiveUserByTokenHash(
      hashX,
      new Date(),
    )
    expect(authenticated).toEqual({ id: user.id, email: "tokuniq@example.com" })

    // Prove second row does not exist.
    const countForHash = await withClient(adminDatabaseUrl, async (client) => {
      const rs = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM microjbase.sessions WHERE token_hash = $1`,
        [hashX],
      )
      return Number(rs.rows[0]?.count ?? 0)
    })
    expect(countForHash).toBe(1)
    expect(await countSessions(adminDatabaseUrl, user.id)).toBe(1)

    // Revoke hash X once; only one session affected.
    const revoked = await repo.revokeByTokenHash(hashX, new Date())
    expect(revoked).toBe(true)
    expect(await repo.findActiveUserByTokenHash(hashX, new Date())).toBeNull()

    const revokedRow = await withClient(adminDatabaseUrl, async (client) => {
      const rs = await client.query<{ id: string; revoked_at: Date | null }>(
        `SELECT id, revoked_at FROM microjbase.sessions WHERE token_hash = $1`,
        [hashX],
      )
      return rs.rows
    })
    expect(revokedRow).toHaveLength(1)
    expect(revokedRow[0]?.id).toBe(session.id)
    expect(revokedRow[0]?.revoked_at).toBeInstanceOf(Date)
  })

  it("does not set microjbase.user_id during createUserAndSession", async () => {
    // BEFORE INSERT triggers raise if microjbase.user_id is set. If
    // createUserAndSession succeeds, identity was absent on both inserts.
    await withClient(adminDatabaseUrl, async (client) => {
      await client.query(`
        CREATE OR REPLACE FUNCTION microjbase.reject_if_user_id_set()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF nullif(current_setting('microjbase.user_id', true), '') IS NOT NULL THEN
            RAISE EXCEPTION 'microjbase.user_id was set during auth registration';
          END IF;
          RETURN NEW;
        END;
        $$;
      `)
      await client.query(`
        CREATE TRIGGER trg_reject_user_id_on_users
          BEFORE INSERT ON microjbase.users
          FOR EACH ROW
          EXECUTE FUNCTION microjbase.reject_if_user_id_set();
      `)
      await client.query(`
        CREATE TRIGGER trg_reject_user_id_on_sessions
          BEFORE INSERT ON microjbase.sessions
          FOR EACH ROW
          EXECUTE FUNCTION microjbase.reject_if_user_id_set();
      `)
    })

    try {
      const { user, session } = await repo.createUserAndSession({
        email: "noidentity@example.com",
        passwordHash: "phash-noidentity",
        tokenHash: tokenHash("noidentity-token-hash-wwwwwwww"),
        expiresAt: futureExpiry(),
      })
      expect(user.email).toBe("noidentity@example.com")
      expect(session.userId).toBe(user.id)
      expect(await countUsers(adminDatabaseUrl, "noidentity@example.com")).toBe(
        1,
      )
      expect(await countSessions(adminDatabaseUrl, user.id)).toBe(1)
    } finally {
      await withClient(adminDatabaseUrl, async (client) => {
        await client.query(
          `DROP TRIGGER IF EXISTS trg_reject_user_id_on_users ON microjbase.users`,
        )
        await client.query(
          `DROP TRIGGER IF EXISTS trg_reject_user_id_on_sessions ON microjbase.sessions`,
        )
        await client.query(
          `DROP FUNCTION IF EXISTS microjbase.reject_if_user_id_set()`,
        )
      })
    }
  })
})
