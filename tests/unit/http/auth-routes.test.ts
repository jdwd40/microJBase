import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"

import { createAuthService, hashTokenBytes } from "../../../src/auth/index.js"
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
  revoked = new Set<string>()

  async createUserAndSession(input: {
    email: string
    passwordHash: string
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<{ user: User; session: Session }> {
    if (this.users.has(input.email)) {
      const error = new Error("Email already registered")
      ;(error as unknown as { code: string }).code = "EMAIL_ALREADY_REGISTERED"
      throw error
    }

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
    const session = this.sessions.get(tokenHash.toString("hex"))
    if (!session) return null
    if (this.revoked.has(session.tokenHash.toString("hex"))) return null
    if (!(session.expiresAt > now)) return null
    const user = [...this.users.values()].find((u) => u.id === session.userId)
    if (!user) return null
    return { id: user.id, email: user.email }
  }

  async revokeByTokenHash(
    tokenHash: Buffer,
    revokedAt: Date,
  ): Promise<boolean> {
    void revokedAt
    const key = tokenHash.toString("hex")
    if (this.sessions.has(key) && !this.revoked.has(key)) {
      this.revoked.add(key)
      return true
    }
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

async function buildTestServer(
  authRepository: FakeAuthRepository,
): Promise<FastifyInstance> {
  const authService = createAuthService(authRepository, {
    sessionTtlSeconds: 3600,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  })
  const dataService = createDataService(
    new FakeTableRegistry(),
    new FakeDataRepository(),
  )
  return buildServer(
    { authService, dataService },
    { disableRequestLogging: true },
  )
}

describe("auth routes", () => {
  let app: FastifyInstance
  let authRepository: FakeAuthRepository
  let token: string

  beforeEach(async () => {
    authRepository = new FakeAuthRepository()
    app = await buildTestServer(authRepository)

    const register = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "alice@example.com",
        password: "correct horse battery staple",
      },
    })
    expect(register.statusCode).toBe(201)
    const body = register.json()
    token = body.data.token
  })

  afterEach(async () => {
    await app.close()
  })

  it("registers a new user and returns snake_case fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "bob@example.com",
        password: "correct horse battery staple",
      },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.data.user).toHaveProperty("created_at")
    expect(body.data).toHaveProperty("expires_at")
    expect(body.data).toHaveProperty("token")
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it("rejects unknown fields on register", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "charlie@example.com",
        password: "correct horse battery staple",
        extra: "field",
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("VALIDATION_ERROR")
    // Regression: every auth response must carry Cache-Control: no-store,
    // including validation errors.
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it("logs in and returns 200", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "alice@example.com",
        password: "correct horse battery staple",
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.user.email).toBe("alice@example.com")
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it("returns identical errors for wrong email and wrong password", async () => {
    const wrongEmail = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "nobody@example.com",
        password: "correct horse battery staple",
      },
    })
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "alice@example.com",
        password: "wrong password",
      },
    })
    expect(wrongEmail.statusCode).toBe(401)
    expect(wrongPassword.statusCode).toBe(401)
    expect(wrongEmail.json()).toEqual(wrongPassword.json())
  })

  it("returns 204 for logout and subsequent /me is 401", async () => {
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(logout.statusCode).toBe(204)
    // Regression: the 204 logout response must still carry no-store.
    expect(logout.headers["cache-control"]).toBe("no-store")

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(me.statusCode).toBe(401)
    expect(me.headers["cache-control"]).toBe("no-store")
  })

  it("returns 204 for logout with an unknown but validly shaped token", async () => {
    const bytes = Buffer.from(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "base64url",
    )
    const rawToken = bytes.toString("base64url")
    const hash = hashTokenBytes(bytes)
    authRepository.sessions.set(hash.toString("hex"), {
      id: randomUUID(),
      userId: randomUUID(),
      tokenHash: hash,
      expiresAt: new Date("2025-01-01T00:00:00.000Z"),
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      revokedAt: null,
    })

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${rawToken}` },
    })
    expect(response.statusCode).toBe(204)
  })

  it("returns 401 for missing or malformed bearer", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
    })
    const malformed = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Basic token" },
    })
    const empty = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Bearer" },
    })
    expect(missing.statusCode).toBe(401)
    expect(malformed.statusCode).toBe(401)
    expect(empty.statusCode).toBe(401)
    // Regression: 401 auth errors must carry no-store too.
    expect(missing.headers["cache-control"]).toBe("no-store")
    expect(malformed.headers["cache-control"]).toBe("no-store")
    expect(empty.headers["cache-control"]).toBe("no-store")
  })

  it("returns 401 for invalid token shape on logout", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: "Bearer not-a-token" },
    })
    expect(response.statusCode).toBe(401)
  })

  it("returns x-request-id on auth responses", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "request-id@example.com",
        password: "correct horse battery staple",
      },
    })
    expect(response.headers["x-request-id"]).toBeDefined()
    expect(response.headers["x-request-id"]).toHaveLength(32)
  })

  it("returns 429 with Retry-After after threshold", async () => {
    for (let i = 0; i < 10; i += 1) {
      await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "alice@example.com", password: "x" },
      })
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "alice@example.com", password: "x" },
    })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/)
    expect(blocked.json().error.code).toBe("RATE_LIMITED")
    // Regression: 429 rate-limit errors must carry no-store.
    expect(blocked.headers["cache-control"]).toBe("no-store")
  })
})
