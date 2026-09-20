import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"

import { createAuthService } from "../../../src/auth/index.js"
import { createDataService } from "../../../src/data/index.js"
import { buildServer } from "../../../src/http/index.js"
import type {
  AuthRepository,
  AuthenticatedUser,
  DataRepository,
  ExposedTable,
  Session,
  TableRegistry,
  User,
  UserId,
  UserRecord,
} from "../../../src/contracts/index.js"
import type { Pool } from "../../../src/database/index.js"

const TEST_TABLE: ExposedTable = {
  alias: "items",
  schema: "public",
  table: "items",
  primaryKey: "id",
  readableColumns: ["id", "name"],
  insertableColumns: ["id", "name"],
  updatableColumns: ["name"],
}

class FakeAuthRepository implements AuthRepository {
  users = new Map<string, UserRecord>()
  sessions = new Map<string, Session>()

  async createUserAndSession(input: {
    email: string
    passwordHash: string
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<{ user: User; session: Session }> {
    const user: UserRecord = {
      id: randomUUID(),
      email: input.email,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      passwordHash: input.passwordHash,
    }
    const session: Session = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: Buffer.from(input.tokenHash),
      expiresAt: input.expiresAt,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      revokedAt: null,
    }
    this.users.set(user.email, user)
    this.sessions.set(session.tokenHash.toString("hex"), session)
    return {
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
      session,
    }
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.users.get(email) ?? null
  }

  async createSession(input: {
    userId: UserId
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: Buffer.from(input.tokenHash),
      expiresAt: input.expiresAt,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      revokedAt: null,
    }
    this.sessions.set(session.tokenHash.toString("hex"), session)
    return session
  }

  async findActiveUserByTokenHash(
    tokenHash: Buffer,
    now: Date,
  ): Promise<AuthenticatedUser | null> {
    void tokenHash
    void now
    return null
  }

  async revokeByTokenHash(
    tokenHash: Buffer,
    revokedAt: Date,
  ): Promise<boolean> {
    void tokenHash
    void revokedAt
    return false
  }
}

class FakeTableRegistry implements TableRegistry {
  get(alias: string): ExposedTable | null {
    if (alias === TEST_TABLE.alias) return TEST_TABLE
    return null
  }

  list(): readonly ExposedTable[] {
    return [TEST_TABLE]
  }
}

class FakeDataRepository implements DataRepository {
  async list() {
    return { items: [], limit: 50, offset: 0 }
  }

  async findById() {
    return null
  }

  async create() {
    return {}
  }

  async updateById() {
    return null
  }

  async deleteById() {
    return false
  }
}

class FailingPool implements Pool {
  async query(): Promise<never> {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:5432")
    ;(error as unknown as Record<string, unknown>)["code"] = "ECONNREFUSED"
    throw error
  }

  async connect(): Promise<never> {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:5432")
    ;(error as unknown as Record<string, unknown>)["code"] = "ECONNREFUSED"
    throw error
  }

  async close(): Promise<void> {
    return undefined
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

/** A pool whose query fails with a non-database error (e.g. a bug). */
class InternalErrorPool implements Pool {
  async query(): Promise<never> {
    throw new Error("unexpected non-database failure")
  }

  async connect(): Promise<never> {
    throw new Error("unexpected non-database failure")
  }

  async close(): Promise<void> {
    return undefined
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

describe("error handling", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    const authService = createAuthService(new FakeAuthRepository(), {
      sessionTtlSeconds: 3600,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })
    const dataService = createDataService(
      new FakeTableRegistry(),
      new FakeDataRepository(),
    )
    app = await buildServer(
      { authService, dataService },
      { disableRequestLogging: true },
    )
  })

  afterEach(async () => {
    await app.close()
  })

  it("returns 503 when health pool query fails", async () => {
    const failingAuthRepository = new FakeAuthRepository()
    const failingDataRepository = new FakeDataRepository()
    const healthApp = await buildServer(
      {
        authService: createAuthService(failingAuthRepository, {
          sessionTtlSeconds: 3600,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        }),
        dataService: createDataService(
          new FakeTableRegistry(),
          failingDataRepository,
        ),
        pool: new FailingPool(),
      },
      { disableRequestLogging: true },
    )

    try {
      const response = await healthApp.inject({
        method: "GET",
        url: "/health",
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe("DATABASE_UNAVAILABLE")
    } finally {
      await healthApp.close()
    }
  })

  it("returns 500 INTERNAL_ERROR when the health query fails unexpectedly", async () => {
    const healthApp = await buildServer(
      {
        authService: createAuthService(new FakeAuthRepository(), {
          sessionTtlSeconds: 3600,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        }),
        dataService: createDataService(
          new FakeTableRegistry(),
          new FakeDataRepository(),
        ),
        pool: new InternalErrorPool(),
      },
      { disableRequestLogging: true },
    )

    try {
      const response = await healthApp.inject({
        method: "GET",
        url: "/health",
      })
      expect(response.statusCode).toBe(500)
      expect(response.json().error.code).toBe("INTERNAL_ERROR")
      // No raw error detail may leak into the envelope.
      expect(JSON.stringify(response.json())).not.toContain(
        "unexpected non-database failure",
      )
    } finally {
      await healthApp.close()
    }
  })

  it("returns 400 for malformed JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("VALIDATION_ERROR")
  })

  it("returns 413 for oversized body", async () => {
    const huge = "x".repeat(2_000_000)
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        email: `${huge}@example.com`,
        password: huge,
      }),
    })
    expect(response.statusCode).toBe(413)
    expect(response.json().error.code).toBe("VALIDATION_ERROR")
  })

  it("returns 404 envelope for unknown routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/unknown",
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe("TABLE_NOT_FOUND")
  })
})
