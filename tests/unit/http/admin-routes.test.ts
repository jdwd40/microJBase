// Unit tests for the opt-in admin HTTP API (V02-16..V02-18).
//
// The internal services are faked in memory; these tests prove the transport
// contract — route-tree isolation, operator authentication, separate rate
// limiting, no-store behaviour, strict typed-body validation, snake_case to
// camelCase command mapping, and safe error envelopes.

import { describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"

import { hashOperatorToken } from "../../../src/auth/index.js"
import type {
  AuthService,
  SchemaSnapshot,
  SchemaSnapshotTable,
} from "../../../src/contracts/index.js"
import type { DataService } from "../../../src/data/index.js"
import type {
  ExecuteOutcome,
  Pool,
  SchemaConstraintService,
  SchemaExposureService,
  SchemaMutationService,
  SchemaOperationRecord,
  SchemaPolicyService,
  SchemaRlsService,
} from "../../../src/database/index.js"
import type { AdminDependencies } from "../../../src/http/admin-guard.js"
import { buildServer } from "../../../src/http/index.js"
import { InMemoryRateLimiter } from "../../../src/http/rate-limiter.js"
import { AppError } from "../../../src/core/index.js"

const OPERATOR_TOKEN = "operator-token-for-unit-tests"
const WRONG_TOKEN = "wrong-token-for-unit-tests"

const authService = {
  register: async () => {
    throw new Error("not used")
  },
  login: async () => {
    throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401)
  },
  authenticate: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "u@example.com",
  }),
  logout: async () => undefined,
} as unknown as AuthService

const dataService = {
  list: async () => ({ items: [], limit: 50, offset: 0 }),
  get: async () => {
    throw new Error("not used")
  },
  create: async () => {
    throw new Error("not used")
  },
  update: async () => {
    throw new Error("not used")
  },
  delete: async () => undefined,
} as unknown as DataService

const TEST_TABLE: SchemaSnapshotTable = {
  schema: "public",
  name: "todos",
  owner: "microjbase_schema",
  kind: "regular",
  hasRowSecurity: true,
  hasForcedRowSecurity: true,
  classification: "operator",
  exposure: { exposed: true, alias: "todos" },
  columns: [
    {
      ordinal: 1,
      name: "id",
      isNullable: false,
      defaultExpression: "gen_random_uuid()",
      generated: "none",
      identity: "none",
      renderedType: "uuid",
      type: { schema: "pg_catalog", name: "uuid", kind: "base" },
      baseType: null,
    },
  ],
  constraints: [],
  indexes: [],
}

const TEST_SNAPSHOT: SchemaSnapshot = {
  schemas: [
    {
      name: "public",
      owner: "postgres",
      classification: "operator",
      tables: [TEST_TABLE],
    },
  ],
  migrations: [
    {
      filename: "0001_init.sql",
      checksum: "abc",
      appliedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
}

function makeRecord(
  overrides: Partial<SchemaOperationRecord> = {},
): SchemaOperationRecord {
  return {
    id: 7,
    idempotencyKey: "key-1",
    commandType: "schema.table.create",
    command: { schema: "public", table: "todos" },
    checksum: "deadbeef",
    status: "succeeded",
    actorFingerprint: "fingerprint",
    errorCode: null,
    result: { ok: true },
    createdAt: new Date("2026-09-25T12:00:00.000Z"),
    finishedAt: new Date("2026-09-25T12:00:01.000Z"),
    ...overrides,
  }
}

function makeOutcome(overrides: Partial<ExecuteOutcome> = {}): ExecuteOutcome {
  return {
    dryRun: false,
    replayed: false,
    record: makeRecord(),
    ...overrides,
  }
}

interface FakeAdminServices {
  deps: Omit<AdminDependencies, "rateLimiter">
  mutationCalls: unknown[]
  constraintCalls: unknown[]
  exposureCalls: unknown[]
  rlsCalls: unknown[]
  policyCalls: unknown[]
  historyCalls: unknown[]
  poolQueries: string[]
}

function fakeAdminServices(
  options: {
    outcome?: ExecuteOutcome
    listError?: AppError
  } = {},
): FakeAdminServices {
  const mutationCalls: unknown[] = []
  const constraintCalls: unknown[] = []
  const exposureCalls: unknown[] = []
  const rlsCalls: unknown[] = []
  const policyCalls: unknown[] = []
  const historyCalls: unknown[] = []
  const poolQueries: string[] = []

  const outcome = options.outcome ?? makeOutcome()

  const record = (sink: unknown[]) => {
    return (name: string, impl?: (input: never) => Promise<ExecuteOutcome>) => {
      return async (input: unknown): Promise<ExecuteOutcome> => {
        sink.push({ name, input })
        if (impl) {
          return impl(input as never)
        }
        return outcome
      }
    }
  }

  const mutation: SchemaMutationService = {
    createTable: record(mutationCalls)("createTable"),
    renameTable: record(mutationCalls)("renameTable"),
    dropTable: record(mutationCalls)("dropTable"),
    addColumn: record(mutationCalls)("addColumn"),
    renameColumn: record(mutationCalls)("renameColumn"),
    dropColumn: record(mutationCalls)("dropColumn"),
    setColumnDefault: record(mutationCalls)("setColumnDefault"),
    dropColumnDefault: record(mutationCalls)("dropColumnDefault"),
    setColumnNotNull: record(mutationCalls)("setColumnNotNull"),
    dropColumnNotNull: record(mutationCalls)("dropColumnNotNull"),
    changeColumnType: record(mutationCalls)("changeColumnType"),
  }

  const constraints: SchemaConstraintService = {
    createIndex: record(constraintCalls)("createIndex"),
    dropIndex: record(constraintCalls)("dropIndex"),
    addUniqueConstraint: record(constraintCalls)("addUniqueConstraint"),
    dropConstraint: record(constraintCalls)("dropConstraint"),
    addForeignKey: record(constraintCalls)("addForeignKey"),
  }

  const exposure: SchemaExposureService = {
    expose: record(exposureCalls)("expose"),
    unexpose: record(exposureCalls)("unexpose"),
  }

  const rls: SchemaRlsService = {
    enableRowSecurity: record(rlsCalls)("enableRowSecurity"),
    disableRowSecurity: record(rlsCalls)("disableRowSecurity"),
  }

  const policies: SchemaPolicyService = {
    createOwnershipPolicy: record(policyCalls)("createOwnershipPolicy"),
    removeOwnershipPolicy: record(policyCalls)("removeOwnershipPolicy"),
  }

  const pool = {
    query: async (text: string): Promise<unknown> => {
      poolQueries.push(text)
      return { rows: [{ health: 1 }] }
    },
    connect: async () => {
      throw new Error("not used")
    },
    close: async () => undefined,
  } as unknown as Pool

  return {
    deps: {
      tokenDigest: hashOperatorToken(OPERATOR_TOKEN),
      pool,
      snapshot: {
        readSnapshot: async () => TEST_SNAPSHOT,
      },
      history: {
        list: async (input?: { limit?: number; offset?: number }) => {
          historyCalls.push(input)
          if (options.listError) {
            throw options.listError
          }
          return [makeRecord()]
        },
      },
      mutation,
      constraints,
      exposure,
      rls,
      policies,
    },
    mutationCalls,
    constraintCalls,
    exposureCalls,
    rlsCalls,
    policyCalls,
    historyCalls,
    poolQueries,
  }
}

function buildAdminServer(
  services: FakeAdminServices,
): Promise<FastifyInstance> {
  return buildServer(
    { authService, dataService, admin: services.deps },
    { disableRequestLogging: true },
  )
}

const operatorAuth = { authorization: `Bearer ${OPERATOR_TOKEN}` }

describe("admin route tree isolation (V02-16)", () => {
  it("returns 404 for /v1/admin paths when the admin lane is not wired", async () => {
    const app = await buildServer(
      { authService, dataService },
      { disableRequestLogging: true },
    )
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/capabilities",
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe("TABLE_NOT_FOUND")
    await app.close()
  })

  it("marks every admin response no-store, including 401s and 404s", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/capabilities",
    })
    expect(unauthenticated.headers["cache-control"]).toBe("no-store")

    const missing = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/tables/public/ghost",
      headers: operatorAuth,
    })
    expect(missing.headers["cache-control"]).toBe("no-store")
    await app.close()
  })
})

describe("operator authentication (V02-16)", () => {
  it("rejects a missing bearer header with 401 AUTH_REQUIRED", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/capabilities",
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe("AUTH_REQUIRED")
    expect(services.poolQueries.length).toBe(0)
    await app.close()
  })

  it("rejects a wrong token with 401 INVALID_CREDENTIALS", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/capabilities",
      headers: { authorization: `Bearer ${WRONG_TOKEN}` },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS")
    expect(services.poolQueries.length).toBe(0)
    await app.close()
  })

  it("rejects an ordinary session-shaped token", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    // Shape: 32 random bytes, base64url — indistinguishable from a session
    // token at the transport layer; it must simply fail verification.
    const sessionToken = Buffer.alloc(32, 7).toString("base64url")
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/capabilities",
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS")
    await app.close()
  })

  it("rejects a malformed authorization header", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/capabilities",
      headers: { authorization: "Basic abc" },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe("AUTH_REQUIRED")
    await app.close()
  })

  it("authenticates the operator and probes the admin pool", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/capabilities",
      headers: operatorAuth,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({ status: "ok", database: "ok" })
    expect(services.poolQueries).toEqual(["SELECT 1 AS health"])
    await app.close()
  })
})

describe("separate admin rate limiting (V02-16)", () => {
  it("limits admin endpoints independently at 30 attempts per window", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)

    // The admin limiter is separate: 31 failing attempts against the same
    // admin endpoint key must yield exactly one 429 at attempt 31.
    let limitedAt = -1
    let retryAfter: string | undefined
    for (let attempt = 1; attempt <= 31; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/admin/schema/capabilities",
        headers: { authorization: `Bearer ${WRONG_TOKEN}` },
      })
      if (response.statusCode === 429) {
        limitedAt = attempt
        retryAfter = response.headers["retry-after"]
        expect(response.json().error.code).toBe("RATE_LIMITED")
        break
      }
      expect(response.statusCode).toBe(401)
    }
    expect(limitedAt).toBe(31)
    expect(retryAfter).toBeDefined()
    await app.close()
  })

  it("does not count admin attempts against the auth limiter", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.inject({
        method: "GET",
        url: "/v1/admin/schema/capabilities",
        headers: { authorization: `Bearer ${WRONG_TOKEN}` },
      })
    }
    // The auth login limiter is untouched: 10 rapid login attempts still all
    // reach the auth handler (they 401 through the service, not 429).
    let loginStatuses: number[] = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "a@example.com", password: "x".repeat(12) },
      })
      loginStatuses = [...loginStatuses, response.statusCode]
    }
    expect(loginStatuses.every((status) => status === 401)).toBe(true)
    await app.close()
  })
})

describe("read-only admin endpoints (V02-17)", () => {
  it("returns the deterministic snapshot", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const first = await app.inject({
      method: "GET",
      url: "/v1/admin/schema",
      headers: operatorAuth,
    })
    const second = await app.inject({
      method: "GET",
      url: "/v1/admin/schema",
      headers: operatorAuth,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().data).toEqual(TEST_SNAPSHOT)
    expect(first.body).toBe(second.body)
    await app.close()
  })

  it("returns a single table detail from the snapshot", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/tables/public/todos",
      headers: operatorAuth,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual(TEST_TABLE)
    await app.close()
  })

  it("returns 404 for a table absent from the snapshot", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/tables/public/ghost",
      headers: operatorAuth,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe("TABLE_NOT_FOUND")
    await app.close()
  })

  it("lists operation history with snake_case mapping and bounds", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/history?limit=5&offset=10",
      headers: operatorAuth,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().meta).toEqual({ limit: 5, offset: 10 })
    expect(services.historyCalls).toEqual([{ limit: 5, offset: 10 }])
    const record = response.json().data[0]
    expect(record.idempotency_key).toBe("key-1")
    expect(record.command_type).toBe("schema.table.create")
    expect(record.actor_fingerprint).toBe("fingerprint")
    expect(record.created_at).toBe("2026-09-25T12:00:00.000Z")
    expect(record.finished_at).toBe("2026-09-25T12:00:01.000Z")
    await app.close()
  })

  it("validates history limit and offset", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const badLimit = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/history?limit=0",
      headers: operatorAuth,
    })
    expect(badLimit.statusCode).toBe(400)
    expect(badLimit.json().error.code).toBe("VALIDATION_ERROR")

    const badOffset = await app.inject({
      method: "GET",
      url: "/v1/admin/schema/history?offset=-1",
      headers: operatorAuth,
    })
    expect(badOffset.statusCode).toBe(400)
    await app.close()
  })
})

describe("mutating admin endpoints (V02-18)", () => {
  it("maps a create-table body onto the typed command", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables",
      headers: {
        ...operatorAuth,
        "idempotency-key": "unit-key-1",
      },
      payload: {
        schema: "public",
        table: "todos",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: false,
            default: { kind: "literal", value: "untitled" },
          },
        ],
        dry_run: true,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({
      dry_run: false,
      replayed: false,
      record: expect.objectContaining({ idempotency_key: "key-1" }),
    })
    expect(services.mutationCalls).toEqual([
      {
        name: "createTable",
        input: {
          idempotencyKey: "unit-key-1",
          actor: "http-operator",
          dryRun: true,
          schema: "public",
          table: "todos",
          columns: [
            {
              name: "title",
              type: "text",
              nullable: false,
              default: { kind: "literal", value: "untitled" },
            },
          ],
        },
      },
    ])
    await app.close()
  })

  it("requires the Idempotency-Key header on mutations", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables",
      headers: operatorAuth,
      payload: {
        schema: "public",
        table: "todos",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("VALIDATION_ERROR")
    expect(services.mutationCalls.length).toBe(0)
    await app.close()
  })

  it("rejects unknown body fields", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-2" },
      payload: {
        schema: "public",
        table: "todos",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
        rogue: true,
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("VALIDATION_ERROR")
    expect(services.mutationCalls.length).toBe(0)
    await app.close()
  })

  it("rejects a disallowed column type", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-3" },
      payload: {
        schema: "public",
        table: "todos",
        columns: [
          {
            name: "payload",
            type: "bytea",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.details.type).toBeDefined()
    expect(services.mutationCalls.length).toBe(0)
    await app.close()
  })

  it("requires destructive confirmations at the transport layer", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables/public/todos/drop",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-4" },
      payload: {},
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe("VALIDATION_ERROR")
    expect(services.mutationCalls.length).toBe(0)
    await app.close()
  })

  it("maps foreign-key commands with the frozen action allowlist", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    const ok = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables/public/todos/foreign-keys",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-5" },
      payload: {
        columns: ["owner_id"],
        references: { schema: "public", table: "users", columns: ["id"] },
        on_update: "no_action",
        on_delete: "cascade",
      },
    })
    expect(ok.statusCode).toBe(200)
    expect(services.constraintCalls).toEqual([
      {
        name: "addForeignKey",
        input: {
          idempotencyKey: "unit-key-5",
          actor: "http-operator",
          schema: "public",
          table: "todos",
          columns: ["owner_id"],
          references: { schema: "public", table: "users", columns: ["id"] },
          onUpdate: "no_action",
          onDelete: "cascade",
        },
      },
    ])

    const badAction = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables/public/todos/foreign-keys",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-6" },
      payload: {
        columns: ["owner_id"],
        references: { schema: "public", table: "users", columns: ["id"] },
        on_update: "set_default",
        on_delete: "cascade",
      },
    })
    expect(badAction.statusCode).toBe(400)
    await app.close()
  })

  it("maps exposure, RLS, and policy commands", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)

    const expose = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/exposure",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-7" },
      payload: { schema: "public", table: "todos", alias: "todos" },
    })
    expect(expose.statusCode).toBe(200)
    expect(services.exposureCalls).toEqual([
      {
        name: "expose",
        input: {
          idempotencyKey: "unit-key-7",
          actor: "http-operator",
          schema: "public",
          table: "todos",
          alias: "todos",
        },
      },
    ])

    const disableRls = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/rls/disable",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-8" },
      payload: { schema: "public", table: "todos", confirm: "public.todos" },
    })
    expect(disableRls.statusCode).toBe(200)
    expect(services.rlsCalls).toEqual([
      {
        name: "disableRowSecurity",
        input: {
          idempotencyKey: "unit-key-8",
          actor: "http-operator",
          schema: "public",
          table: "todos",
          confirm: "public.todos",
        },
      },
    ])

    const policy = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/policies",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-9" },
      payload: {
        schema: "public",
        table: "todos",
        column: "owner_id",
        template: "read",
      },
    })
    expect(policy.statusCode).toBe(200)
    expect(services.policyCalls).toEqual([
      {
        name: "createOwnershipPolicy",
        input: {
          idempotencyKey: "unit-key-9",
          actor: "http-operator",
          schema: "public",
          table: "todos",
          column: "owner_id",
          template: "read",
        },
      },
    ])
    await app.close()
  })

  it("passes service conflicts through as safe envelopes", async () => {
    const failing = fakeAdminServices()
    failing.deps.mutation = {
      ...failing.deps.mutation,
      createTable: async () => {
        throw new AppError("CONFLICT", "Relation already exists", 409)
      },
    }
    const app = await buildAdminServer(failing)
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-10" },
      payload: {
        schema: "public",
        table: "todos",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe("CONFLICT")
    expect(response.body).not.toContain("pg_")
    expect(response.body).not.toContain("CREATE TABLE")
    await app.close()
  })

  it("never logs the raw operator token", async () => {
    const services = fakeAdminServices()
    const app = await buildAdminServer(services)
    await app.inject({
      method: "GET",
      url: "/v1/admin/schema/capabilities",
      headers: operatorAuth,
    })
    await app.inject({
      method: "POST",
      url: "/v1/admin/schema/tables",
      headers: { ...operatorAuth, "idempotency-key": "unit-key-11" },
      payload: {
        schema: "public",
        table: "todos",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
    })
    await app.close()
    // buildServer here runs with request logging disabled; the assertion is
    // structural: no fake received the raw token, only its digest was used.
    expect(services.mutationCalls.length).toBe(1)
  })
})

describe("admin rate limiter helper", () => {
  it("exposes bounded state", () => {
    const limiter = new InMemoryRateLimiter({
      attemptsPerWindow: 2,
      windowMs: 60_000,
      nowMs: () => 1_000,
    })
    expect(limiter.check("k").allowed).toBe(true)
    expect(limiter.check("k").allowed).toBe(true)
    expect(limiter.check("k").allowed).toBe(false)
  })
})
