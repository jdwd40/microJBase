import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import type { Pool } from "../../src/database/index.js"

import { buildServer } from "../../src/http/server.js"
import { createAuthService } from "../../src/auth/index.js"
import { createDataService } from "../../src/data/index.js"

// Placeholder smoke test proving the server responds over HTTP injection.
// Real end-to-end tests start the compiled server against a clean database
// in the e2e PR.
describe("toolchain smoke (e2e)", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildServer(
      {
        authService: createAuthService(new FakeAuthRepository()),
        dataService: createDataService(
          new FakeTableRegistry(),
          new FakeDataRepository(),
        ),
        pool: new FailingPool(),
      },
      { disableRequestLogging: true },
    )
  })

  afterEach(async () => {
    await app.close()
  })

  it("serves the health envelope", async () => {
    const response = await app.inject({ method: "GET", url: "/health" })

    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe("DATABASE_UNAVAILABLE")
  })
})

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

class FakeAuthRepository {
  async createUserAndSession() {
    return {
      user: {
        id: randomUUID(),
        email: "test@example.com",
        createdAt: new Date(),
      },
      session: {
        id: randomUUID(),
        userId: randomUUID(),
        tokenHash: Buffer.alloc(32),
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        revokedAt: null,
      },
    }
  }

  async findByEmail() {
    return null
  }

  async createSession() {
    return {
      id: randomUUID(),
      userId: randomUUID(),
      tokenHash: Buffer.alloc(32),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      revokedAt: null,
    }
  }

  async findActiveUserByTokenHash() {
    return null
  }

  async revokeByTokenHash() {
    return false
  }
}

class FakeTableRegistry {
  get() {
    return null
  }

  list() {
    return []
  }
}

class FakeDataRepository {
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
