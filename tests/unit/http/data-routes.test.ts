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
  DataRow,
  ExposedTable,
  Page,
  RequestIdentity,
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
    void now
    const session = this.sessions.get(tokenHash.toString("hex"))
    if (!session) return null
    const user = [...this.users.values()].find((u) => u.id === session.userId)
    if (!user) return null
    return { id: user.id, email: user.email }
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

type StoredRow = DataRow & { _ownerId: string }

class FakeDataRepository implements DataRepository {
  rows = new Map<string, StoredRow[]>()

  seed(alias: string, ownerId: string, row: DataRow): void {
    const stored: StoredRow = { ...row, _ownerId: ownerId }
    const list = this.rows.get(alias) ?? []
    list.push(stored)
    this.rows.set(alias, list)
  }

  private publicRow(stored: StoredRow): DataRow {
    const { _ownerId, ...rest } = stored
    void _ownerId
    return rest
  }

  private owned(alias: string, userId: string): StoredRow[] {
    return (this.rows.get(alias) ?? []).filter((r) => r._ownerId === userId)
  }

  async list(input: {
    identity: RequestIdentity
    table: ExposedTable
    limit: number
    offset: number
  }): Promise<Page<DataRow>> {
    const owned = this.owned(input.table.alias, input.identity.userId)
    const sorted = [...owned].sort((a, b) =>
      String(a["id"]).localeCompare(String(b["id"])),
    )
    const sliced = sorted.slice(input.offset, input.offset + input.limit)
    return {
      items: sliced.map((r) => this.publicRow(r)),
      limit: input.limit,
      offset: input.offset,
    }
  }

  async findById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
  }): Promise<DataRow | null> {
    const owned = this.owned(input.table.alias, input.identity.userId)
    const row = owned.find((r) => r["id"] === input.id)
    return row ? this.publicRow(row) : null
  }

  async create(input: {
    identity: RequestIdentity
    table: ExposedTable
    values: DataRow
  }): Promise<DataRow> {
    const row: StoredRow = { ...input.values, _ownerId: input.identity.userId }
    const list = this.rows.get(input.table.alias) ?? []
    list.push(row)
    this.rows.set(input.table.alias, list)
    return this.publicRow(row)
  }

  async updateById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
    values: DataRow
  }): Promise<DataRow | null> {
    const owned = this.owned(input.table.alias, input.identity.userId)
    const index = owned.findIndex((r) => r["id"] === input.id)
    if (index === -1) return null
    const target = owned[index]
    if (target === undefined) return null
    Object.assign(target, input.values)
    return this.publicRow(target)
  }

  async deleteById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
  }): Promise<boolean> {
    const owned = this.owned(input.table.alias, input.identity.userId)
    const index = owned.findIndex((r) => r["id"] === input.id)
    if (index === -1) return false
    const list = this.rows.get(input.table.alias)
    if (list) {
      const fullIndex = list.findIndex(
        (r) => r["id"] === input.id && r._ownerId === input.identity.userId,
      )
      if (fullIndex !== -1) list.splice(fullIndex, 1)
    }
    return true
  }
}

async function buildTestServer(
  authRepository: FakeAuthRepository,
  dataRepository: FakeDataRepository,
): Promise<FastifyInstance> {
  const authService = createAuthService(authRepository, {
    sessionTtlSeconds: 3600,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  })
  const dataService = createDataService(new FakeTableRegistry(), dataRepository)
  return buildServer(
    { authService, dataService },
    { disableRequestLogging: true },
  )
}

describe("data routes", () => {
  let app: FastifyInstance
  let authRepository: FakeAuthRepository
  let dataRepository: FakeDataRepository
  let token: string
  let userId: string

  beforeEach(async () => {
    authRepository = new FakeAuthRepository()
    dataRepository = new FakeDataRepository()
    app = await buildTestServer(authRepository, dataRepository)

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
    userId = body.data.user.id
  })

  afterEach(async () => {
    await app.close()
  })

  it("lists rows with pagination envelope", async () => {
    dataRepository.seed("items", userId, { id: randomUUID(), name: "first" })
    dataRepository.seed("items", userId, { id: randomUUID(), name: "second" })

    const response = await app.inject({
      method: "GET",
      url: "/v1/data/items?limit=1&offset=0",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data).toHaveLength(1)
    expect(body.meta).toEqual({ limit: 1, offset: 0 })
  })

  it("gets one row", async () => {
    const id = randomUUID()
    dataRepository.seed("items", userId, { id, name: "item" })

    const response = await app.inject({
      method: "GET",
      url: `/v1/data/items/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.name).toBe("item")
  })

  it("creates a row", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/data/items",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "new item" },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().data.name).toBe("new item")
  })

  it("updates a row", async () => {
    const id = randomUUID()
    dataRepository.seed("items", userId, { id, name: "old" })

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/data/items/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "updated" },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.name).toBe("updated")
  })

  it("deletes a row", async () => {
    const id = randomUUID()
    dataRepository.seed("items", userId, { id, name: "to delete" })

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/data/items/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(204)
  })

  it("returns 404 for unknown table", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/data/unknown",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe("TABLE_NOT_FOUND")
  })

  it("returns 404 for hidden row", async () => {
    const id = randomUUID()
    dataRepository.seed("items", randomUUID(), { id, name: "other user" })

    const response = await app.inject({
      method: "GET",
      url: `/v1/data/items/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe("ROW_NOT_FOUND")
  })

  it("requires bearer for data routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/data/items",
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe("AUTH_REQUIRED")
  })
})
