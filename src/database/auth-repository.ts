// PostgreSQL AuthRepository adapter for microJBase v0.1.
//
// Implements the frozen AuthRepository port against microjbase.users and
// microjbase.sessions. Registration inserts the user and initial session in
// one transaction (no microjbase.user_id). Unique-email conflicts become
// EMAIL_ALREADY_REGISTERED; raw PostgreSQL details never cross the port.

import type {
  AuthenticatedUser,
  AuthRepository,
  Session,
  User,
  UserId,
  UserRecord,
} from "../contracts/index.js"
import { AppError } from "../core/index.js"
import type { Pool } from "./pool.js"
import { createTransactionRunner } from "./transaction.js"

interface UserRow {
  id: string
  email: string
  created_at: Date
}

interface UserRecordRow extends UserRow {
  password_hash: string
}

interface SessionRow {
  id: string
  user_id: string
  token_hash: Buffer
  expires_at: Date
  created_at: Date
  revoked_at: Date | null
}

interface AuthenticatedUserRow {
  id: string
  email: string
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
  }
}

function mapUserRecord(row: UserRecordRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
  }
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }
  return (error as { code?: unknown }).code === "23505"
}

class PostgresAuthRepository implements AuthRepository {
  private readonly runner

  constructor(private readonly pool: Pool) {
    this.runner = createTransactionRunner(() => this.pool.connect())
  }

  async createUserAndSession(input: {
    email: string
    passwordHash: string
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<{ user: User; session: Session }> {
    // No userId option: auth registration does not set microjbase.user_id.
    return this.runner.withTransaction(async (ctx) => {
      let userRow: UserRow | undefined
      try {
        const userResult = await ctx.query<UserRow>(
          `INSERT INTO microjbase.users (email, password_hash)
           VALUES ($1, $2)
           RETURNING id, email, created_at`,
          [input.email, input.passwordHash],
        )
        userRow = userResult.rows[0]
      } catch (error: unknown) {
        // Translate unique-email conflicts before translatePoolError would
        // wrap them as INTERNAL_ERROR. AppError is passed through unchanged.
        if (isPgUniqueViolation(error)) {
          throw new AppError(
            "EMAIL_ALREADY_REGISTERED",
            "Email already registered",
            409,
          )
        }
        throw error
      }

      if (userRow === undefined) {
        throw new AppError(
          "INTERNAL_ERROR",
          "An unexpected database error occurred",
          500,
        )
      }

      const sessionResult = await ctx.query<SessionRow>(
        `INSERT INTO microjbase.sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id, user_id, token_hash, expires_at, created_at, revoked_at`,
        [userRow.id, input.tokenHash, input.expiresAt],
      )
      const sessionRow = sessionResult.rows[0]
      if (sessionRow === undefined) {
        throw new AppError(
          "INTERNAL_ERROR",
          "An unexpected database error occurred",
          500,
        )
      }

      return {
        user: mapUser(userRow),
        session: mapSession(sessionRow),
      }
    })
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRecordRow>(
      `SELECT id, email, password_hash, created_at
       FROM microjbase.users
       WHERE email = $1`,
      [email],
    )
    const row = result.rows[0]
    return row === undefined ? null : mapUserRecord(row)
  }

  async createSession(input: {
    userId: UserId
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<Session> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO microjbase.sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, expires_at, created_at, revoked_at`,
      [input.userId, input.tokenHash, input.expiresAt],
    )
    const row = result.rows[0]
    if (row === undefined) {
      throw new AppError(
        "INTERNAL_ERROR",
        "An unexpected database error occurred",
        500,
      )
    }
    return mapSession(row)
  }

  async findActiveUserByTokenHash(
    tokenHash: Buffer,
    now: Date,
  ): Promise<AuthenticatedUser | null> {
    // token_hash is indexed but not UNIQUE in migration 0002. Prefer the
    // newest matching active session when duplicates exist (should not).
    const result = await this.pool.query<AuthenticatedUserRow>(
      `SELECT u.id, u.email
       FROM microjbase.sessions s
       INNER JOIN microjbase.users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > $2
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [tokenHash, now],
    )
    const row = result.rows[0]
    return row === undefined ? null : { id: row.id, email: row.email }
  }

  async revokeByTokenHash(
    tokenHash: Buffer,
    revokedAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE microjbase.sessions
       SET revoked_at = $2
       WHERE token_hash = $1
         AND revoked_at IS NULL
       RETURNING id`,
      [tokenHash, revokedAt],
    )
    return result.rowCount !== null && result.rowCount > 0
  }
}

export function createAuthRepository(pool: Pool): AuthRepository {
  return new PostgresAuthRepository(pool)
}
