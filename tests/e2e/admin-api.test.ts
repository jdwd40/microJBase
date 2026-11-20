// E2E acceptance for the opt-in admin API (V02-16..V02-18).
//
// Covers, against the real compiled server and real PostgreSQL:
//
//  V02-16  route-tree isolation (no admin lane => /v1/admin is a plain 404),
//          operator-token auth (missing / wrong / ordinary-session tokens all
//          fail), separate admin rate limiting, no-store on every admin
//          response, and the authenticated capability probe;
//  V02-17  deterministic snapshot, table detail, and operation history;
//  V02-18  the full typed-mutation matrix — tables, columns, defaults,
//          nullability, the frozen type-change matrix, indexes, unique
//          constraints, foreign keys, RLS, ownership policies, expose /
//          unexpose, idempotency replay + conflict, dry runs, destructive
//          confirmations, and the exposed-table mutation guard — with no SQL
//          or internal detail ever crossing the public envelope.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { E2E_ADMIN_TOKEN, adminTokenDigestHex } from "./helpers/config.js"
import { adminQuery } from "./helpers/database.js"
import {
  type ApiResponse,
  createApi,
  expectError,
  expectNoStore,
  nonce,
  registerUser,
} from "./helpers/http.js"
import { startE2EFile, stopE2EFile } from "./helpers/lifecycle.js"
import { startE2EServer } from "./helpers/server.js"

const OP = E2E_ADMIN_TOKEN

let context: Awaited<ReturnType<typeof startE2EFile>>

beforeAll(async () => {
  context = await startE2EFile({ admin: true })
}, 180_000)

afterAll(async () => {
  await stopE2EFile(context)
  const logs = context.server.output()
  expect(logs).not.toContain(OP)
  expect(logs).not.toContain(adminTokenDigestHex())
})

function adminHeaders(idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${OP}`,
    "content-type": "application/json",
  }
  if (idempotencyKey !== undefined) {
    headers["idempotency-key"] = idempotencyKey
  }
  return headers
}

async function adminGet(path: string): Promise<ApiResponse> {
  return context.api.get(path, OP)
}

async function adminMutate(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<ApiResponse> {
  return context.api.postWithHeaders(path, body, adminHeaders(idempotencyKey))
}

function expectNoSqlLeakage(response: ApiResponse): void {
  const forbidden =
    /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|POLICY)|pg_catalog|SQLSTATE|at .*\.ts\b/i
  if (forbidden.test(response.text)) {
    throw new Error(`possible SQL/internal leakage: ${response.text}`)
  }
}

describe("admin lane disabled (V02-16 route-tree isolation)", () => {
  it("returns 404 for the whole /v1/admin tree when not configured", async () => {
    // A dedicated plain server against the same database; the admin lane is
    // absent, so no admin route exists at all.
    const plain = await startE2EServer({})
    try {
      const api = createApi(plain.baseUrl)
      const probe = await api.get("/v1/admin/schema/capabilities")
      expect(probe.status).toBe(404)
      expectNoStore(probe)

      const snapshot = await api.get("/v1/admin/schema", OP)
      expect(snapshot.status).toBe(404)

      const mutation = await api.postWithHeaders(
        "/v1/admin/schema/tables",
        { schema: "public", table: "x", columns: [] },
        adminHeaders("plain-1"),
      )
      expect(mutation.status).toBe(404)
      expectNoSqlLeakage(mutation)
    } finally {
      await plain.stop()
    }
  }, 60_000)
})

describe("operator authentication (V02-16)", () => {
  it("rejects a missing bearer header with 401 AUTH_REQUIRED", async () => {
    const response = await context.api.get("/v1/admin/schema/capabilities")
    expectError(response, 401, "AUTH_REQUIRED")
    expectNoStore(response)
  })

  it("rejects a wrong operator token with 401 INVALID_CREDENTIALS", async () => {
    const response = await context.api.get(
      "/v1/admin/schema/capabilities",
      "definitely-not-the-operator-token",
    )
    expectError(response, 401, "INVALID_CREDENTIALS")
    expectNoStore(response)
  })

  it("rejects ordinary session tokens from every admin surface", async () => {
    const user = await registerUser(
      context.api,
      `admin-reject-${nonce()}@example.com`,
    )

    const probe = await context.api.get(
      "/v1/admin/schema/capabilities",
      user.token,
    )
    expectError(probe, 401, "INVALID_CREDENTIALS")

    const snapshot = await context.api.get("/v1/admin/schema", user.token)
    expectError(snapshot, 401, "INVALID_CREDENTIALS")

    const history = await context.api.get(
      "/v1/admin/schema/history",
      user.token,
    )
    expectError(history, 401, "INVALID_CREDENTIALS")

    const mutation = await context.api.postWithHeaders(
      "/v1/admin/schema/tables",
      {
        schema: "public",
        table: "nope",
        columns: [
          {
            name: "title",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
      { authorization: `Bearer ${user.token}`, "idempotency-key": "sess-1" },
    )
    expectError(mutation, 401, "INVALID_CREDENTIALS")
  })

  it("does not accept the operator token as a session token", async () => {
    const response = await context.api.get("/v1/auth/me", OP)
    expectError(response, 401, "AUTH_REQUIRED")
    const dataRoute = await context.api.get("/v1/data/todos", OP)
    expectError(dataRoute, 401, "AUTH_REQUIRED")
  })

  it("probes capabilities with the operator token and never leaks it", async () => {
    const response = await adminGet("/v1/admin/schema/capabilities")
    if (response.status !== 200) {
      throw new Error(`probe failed: ${response.status} ${response.text}`)
    }
    expect((response.body as { data: unknown }).data).toEqual({
      status: "ok",
      database: "ok",
    })
    expectNoStore(response)
    expect(context.server.output()).not.toContain(OP)
    expect(context.server.output()).not.toContain(adminTokenDigestHex())
  })

  it("rate-limits the admin tree separately after 30 attempts", async () => {
    // A fresh server process (fresh in-memory limiter) so the count starts
    // at zero: 30 x 401, then 429 RATE_LIMITED with Retry-After.
    const fresh = await startE2EServer({ admin: true })
    try {
      const api = createApi(fresh.baseUrl)
      let sawLimited = false
      for (let attempt = 1; attempt <= 31; attempt += 1) {
        const response = await api.get(
          "/v1/admin/schema/capabilities",
          "wrong-token",
        )
        if (response.status === 429) {
          expect(attempt).toBe(31)
          expectError(response, 429, "RATE_LIMITED")
          expect(response.headers.get("retry-after")).toBeTruthy()
          expectNoStore(response)
          sawLimited = true
          break
        }
        expectError(response, 401, "INVALID_CREDENTIALS")
      }
      expect(sawLimited).toBe(true)
    } finally {
      await fresh.stop()
    }
  }, 60_000)
})

describe("read-only admin endpoints (V02-17)", () => {
  it("returns a deterministic snapshot with exposure and migration state", async () => {
    const first = await adminGet("/v1/admin/schema")
    const second = await adminGet("/v1/admin/schema")
    if (first.status !== 200) {
      throw new Error(`snapshot failed: ${first.status} ${first.text}`)
    }
    expect(first.body).toEqual(second.body)
    expectNoStore(first)

    const snapshot = first.body as {
      data: {
        schemas: { name: string; tables: { name: string }[] }[]
        migrations: { filename: string }[]
      }
    }
    const publicSchema = snapshot.data.schemas.find(
      (entry) => entry.name === "public",
    )
    expect(publicSchema).toBeDefined()
    expect(publicSchema?.tables.some((table) => table.name === "todos")).toBe(
      true,
    )
    const filenames = snapshot.data.migrations.map((m) => m.filename)
    expect(filenames).toContain("0001_microjbase_schema.sql")
    expect(filenames).toContain("0007_exposure_registry_revoke_public.sql")
  })

  it("reports per-table exposure state in the snapshot and table detail", async () => {
    const detail = await adminGet("/v1/admin/schema/tables/public/todos")
    if (detail.status !== 200) {
      throw new Error(`table detail failed: ${detail.status} ${detail.text}`)
    }
    const table = (detail.body as { data: Record<string, unknown> }).data
    expect(table.name).toBe("todos")
    expect(table.exposure).toEqual({ exposed: true, alias: "todos" })
    expect(table.hasRowSecurity).toBe(true)
    expect(table.hasForcedRowSecurity).toBe(true)
    expectNoStore(detail)
  })

  it("returns 404 for unknown tables", async () => {
    const response = await adminGet("/v1/admin/schema/tables/public/ghost")
    expectError(response, 404, "TABLE_NOT_FOUND")
    expectNoSqlLeakage(response)
  })

  it("validates history pagination bounds", async () => {
    const badLimit = await adminGet("/v1/admin/schema/history?limit=501")
    expectError(badLimit, 400, "VALIDATION_ERROR")
    const badOffset = await adminGet("/v1/admin/schema/history?offset=-3")
    expectError(badOffset, 400, "VALIDATION_ERROR")
  })
})

describe("typed mutation matrix (V02-18)", () => {
  const run = nonce()
  const alias = `b6x_${run}`
  // Dedicated operator schema owned by the schema-admin role (provisioning).
  const schema = "e2e_admin"
  let keyCounter = 0
  const nextKey = (): string => `b6-${run}-${(keyCounter += 1)}`

  // Each scenario owns its tables and checks the durable records it produced.
  const expectedHistory = new Map<string, string>()

  function expectMutationOk(response: ApiResponse, commandType: string): void {
    expect(response.status, response.text).toBe(200)
    const data = (
      response.body as {
        data: {
          dry_run: boolean
          replayed: boolean
          record: { idempotency_key: string; command_type: string }
        }
      }
    ).data
    expect(data).toMatchObject({
      dry_run: false,
      replayed: false,
      record: {
        command_type: commandType,
        idempotency_key: expect.any(String),
      },
    })
    expectedHistory.set(data.record.idempotency_key, commandType)
  }

  afterEach(async () => {
    const entries = [...expectedHistory]
    expectedHistory.clear()
    if (!entries.length) return
    const history = await adminGet("/v1/admin/schema/history?limit=100")
    expect(history.status, history.text).toBe(200)
    const records = (history.body as { data: Record<string, unknown>[] }).data
    for (const [idempotencyKey, commandType] of entries) {
      const recorded = records.find(
        (record) => record.idempotency_key === idempotencyKey,
      )
      expect(recorded, idempotencyKey).toMatchObject({
        command_type: commandType,
        status: "succeeded",
      })
    }
    // Newest first, all terminal, safe actor fingerprints only.
    const timestamps = records.map((record) =>
      Date.parse(record.created_at as string),
    )
    for (let index = 1; index < timestamps.length; index += 1) {
      const previous = timestamps[index - 1] as number
      const current = timestamps[index] as number
      expect(previous).toBeGreaterThanOrEqual(current)
    }
    for (const record of records) {
      expect(["succeeded", "failed"]).toContain(record.status)
      expect(record.actor_fingerprint).toBeTruthy()
      expect(record.actor_fingerprint).not.toBe("http-operator")
    }
  })

  function createTable(table: string, withMemo = false): Promise<ApiResponse> {
    return adminMutate(
      "/v1/admin/schema/tables",
      {
        schema,
        table,
        columns: [
          {
            name: "title",
            type: "text",
            nullable: false,
            default: { kind: "literal", value: "untitled" },
          },
          {
            name: "owner_id",
            type: "uuid",
            nullable: true,
            default: { kind: "none" },
          },
          {
            name: "qty",
            type: "integer",
            nullable: true,
            default: { kind: "none" },
          },
          ...(withMemo
            ? [
                {
                  name: "memo",
                  type: "text",
                  nullable: true,
                  default: { kind: "none" },
                },
              ]
            : []),
        ],
      },
      nextKey(),
    )
  }

  async function fixtureTable(
    label: string,
    withMemo = false,
  ): Promise<string> {
    const table = `b6_${label}_${run}`
    expectMutationOk(await createTable(table, withMemo), "schema.table.create")
    return table
  }

  async function tableExists(table: string): Promise<boolean> {
    const result = await adminQuery<{ present: boolean }>(
      "SELECT EXISTS (SELECT FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = $2) AS present",
      [schema, table],
    )
    return result.rows[0]!.present
  }

  async function enableOwnership(table: string): Promise<void> {
    const enableRls = await adminMutate(
      `/v1/admin/schema/rls/enable`,
      { schema, table },
      nextKey(),
    )
    expectMutationOk(enableRls, "schema.rls.enable")

    for (const template of ["read", "insert", "update", "delete"] as const) {
      const policy = await adminMutate(
        `/v1/admin/schema/policies`,
        { schema, table, column: "owner_id", template },
        nextKey(),
      )
      expectMutationOk(policy, "schema.policy.create")
    }
  }

  it("creates a table and records it durably", async () => {
    const table = `b6_created_${run}`
    const response = await createTable(table)
    expectMutationOk(response, "schema.table.create")

    // Deterministic shape: envelope + snake_case record.
    const record = (
      response.body as { data: { record: Record<string, unknown> } }
    ).data.record
    expect(record.command_type).toBe("schema.table.create")
    expect(record.status).toBe("succeeded")
    expect(record.actor_fingerprint).toBeTruthy()
    expect(record.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // The table is visible in the snapshot with module-managed shape.
    const detail = await adminGet(`/v1/admin/schema/tables/${schema}/${table}`)
    expect(detail.status).toBe(200)
    const data = (detail.body as { data: Record<string, unknown> }).data
    const columnNames = (data.columns as { name: string }[]).map((c) => c.name)
    expect(columnNames).toContain("id")
    expect(columnNames).toContain("title")
    expect(columnNames).toContain("owner_id")

    // And in the durable history.
    const history = await adminGet("/v1/admin/schema/history?limit=5")
    const commands = (
      history.body as { data: { command_type: string }[] }
    ).data.map((entry) => entry.command_type)
    expect(commands).toContain("schema.table.create")
  })

  it("replays the same idempotency key and conflicts on a different command", async () => {
    const table = await fixtureTable("replay")
    const key = nextKey()
    const first = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/rename`,
      { new_name: `${table}_renamed` },
      key,
    )
    expectMutationOk(first, "schema.table.rename")

    const replay = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/rename`,
      { new_name: `${table}_renamed` },
      key,
    )
    expect(replay.status).toBe(200)
    const replayed = (replay.body as { data: { replayed: boolean } }).data
      .replayed
    expect(replayed).toBe(true)

    // Restore the original name before attempting to reuse the key.
    const back = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}_renamed/rename`,
      { new_name: table },
      nextKey(),
    )
    expectMutationOk(back, "schema.table.rename")

    const conflict = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/rename`,
      { new_name: "something_else" },
      key,
    )
    expectError(conflict, 409, "CONFLICT")
    expectNoSqlLeakage(conflict)
  })

  it("enforces idempotency keys and strict bodies on mutations", async () => {
    const table = await fixtureTable("validation")
    const noKey = await context.api.postWithHeaders(
      "/v1/admin/schema/tables",
      {
        schema,
        table: "never",
        columns: [
          {
            name: "t",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
      adminHeaders(),
    )
    expectError(noKey, 400, "VALIDATION_ERROR")
    expectNoSqlLeakage(noKey)

    const badKey = await context.api.postWithHeaders(
      "/v1/admin/schema/tables",
      {
        schema,
        table: "never",
        columns: [
          {
            name: "t",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
      adminHeaders("key with spaces"),
    )
    expectError(badKey, 400, "VALIDATION_ERROR")

    const unknownField = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns`,
      {
        column: {
          name: "x",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
        rogue: 1,
      },
      nextKey(),
    )
    expectError(unknownField, 400, "VALIDATION_ERROR")

    const badType = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns`,
      {
        column: {
          name: "payload",
          type: "bytea",
          nullable: true,
          default: { kind: "none" },
        },
      },
      nextKey(),
    )
    expectError(badType, 400, "VALIDATION_ERROR")
  })

  it("dry runs compile and preflight without writing history or state", async () => {
    const ghost = `b6_dry_${run}`
    const response = await adminMutate(
      "/v1/admin/schema/tables",
      {
        schema,
        table: ghost,
        columns: [
          {
            name: "t",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        ],
        dry_run: true,
      },
      nextKey(),
    )
    expect(response.status).toBe(200)
    const data = (response.body as { data: Record<string, unknown> }).data
    expect(data.dry_run).toBe(true)
    expect(data.record).toBeNull()

    const detail = await adminGet(`/v1/admin/schema/tables/${schema}/${ghost}`)
    expectError(detail, 404, "TABLE_NOT_FOUND")

    // History must not contain the dry-run ghost command either.
    const history = await adminGet("/v1/admin/schema/history?limit=50")
    const json = JSON.stringify(history.body)
    expect(json).not.toContain(ghost)
    expect(await tableExists(ghost)).toBe(false)
  })

  it("manages columns: add, rename, defaults, nullability, frozen type matrix", async () => {
    const table = await fixtureTable("columns")
    const add = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns`,
      {
        column: {
          name: "note",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      },
      nextKey(),
    )
    expectMutationOk(add, "schema.column.add")

    const rename = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/note/rename`,
      { new_name: "memo" },
      nextKey(),
    )
    expectMutationOk(rename, "schema.column.rename")

    const setDefault = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/memo/default`,
      { default: { kind: "literal", value: "n/a" } },
      nextKey(),
    )
    expectMutationOk(setDefault, "schema.column.default.set")

    const dropDefault = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/memo/default/drop`,
      {},
      nextKey(),
    )
    expectMutationOk(dropDefault, "schema.column.default.drop")

    const setNotNull = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/qty/not-null`,
      {},
      nextKey(),
    )
    expectMutationOk(setNotNull, "schema.column.not_null.set")

    const dropNotNull = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/qty/nullable`,
      {},
      nextKey(),
    )
    expectMutationOk(dropNotNull, "schema.column.not_null.drop")

    // Matrix-approved widening succeeds...
    const widen = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/qty/type`,
      { to_type: "bigint" },
      nextKey(),
    )
    expectMutationOk(widen, "schema.column.type.change")

    // ...and anything outside the frozen matrix refuses safely.
    const unsupported = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/qty/type`,
      { to_type: "uuid" },
      nextKey(),
    )
    expectError(unsupported, 400, "VALIDATION_ERROR")
    expectNoSqlLeakage(unsupported)

    const detail = await adminGet(`/v1/admin/schema/tables/${schema}/${table}`)
    const columns = (
      detail.body as {
        data: { columns: { name: string; renderedType: string }[] }
      }
    ).data.columns.map((column) => `${column.name}:${column.renderedType}`)
    expect(columns).toContain("memo:text")
    expect(columns).toContain("qty:bigint")
  })

  it("manages indexes and unique constraints with explicit names", async () => {
    const table = await fixtureTable("indexes", true)
    const indexName = `b6_idx_${run}`
    const create = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/indexes`,
      { columns: ["memo"], name: indexName },
      nextKey(),
    )
    expectMutationOk(create, "schema.index.create")

    const uniqueName = `b6_uq_${run}`
    const unique = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/unique-constraints`,
      { columns: ["memo"], name: uniqueName },
      nextKey(),
    )
    expectMutationOk(unique, "schema.constraint.unique.add")

    const dropUnique = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/constraints/${uniqueName}/drop`,
      {},
      nextKey(),
    )
    expectMutationOk(dropUnique, "schema.constraint.drop")

    const dropIndex = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/indexes/${indexName}/drop`,
      {},
      nextKey(),
    )
    expectMutationOk(dropIndex, "schema.index.drop")
  })

  it("manages foreign keys on the frozen action allowlist", async () => {
    const table = await fixtureTable("parent")
    const child = `b6_child_${run}`
    const createChild = await adminMutate(
      "/v1/admin/schema/tables",
      {
        schema,
        table: child,
        columns: [
          {
            name: "parent_id",
            type: "uuid",
            nullable: true,
            default: { kind: "none" },
          },
        ],
      },
      nextKey(),
    )
    expectMutationOk(createChild, "schema.table.create")

    const fkName = `b6_fk_${run}`
    const addFk = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${child}/foreign-keys`,
      {
        columns: ["parent_id"],
        references: { schema, table, columns: ["id"] },
        on_update: "no_action",
        on_delete: "cascade",
        name: fkName,
      },
      nextKey(),
    )
    expectMutationOk(addFk, "schema.foreign_key.add")

    // set_default is not representable anywhere in the command surface.
    const badAction = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${child}/foreign-keys`,
      {
        columns: ["parent_id"],
        references: { schema, table, columns: ["id"] },
        on_update: "set_default",
        on_delete: "cascade",
        name: `${fkName}_2`,
      },
      nextKey(),
    )
    expectError(badAction, 400, "VALIDATION_ERROR")

    // The referenced table now cannot be dropped (dependency-aware refusal).
    const dropReferenced = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/drop`,
      { confirm: `${schema}.${table}` },
      nextKey(),
    )
    expectError(dropReferenced, 409, "CONFLICT")
    expectNoSqlLeakage(dropReferenced)

    const dropFk = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${child}/constraints/${fkName}/drop`,
      {},
      nextKey(),
    )
    expectMutationOk(dropFk, "schema.constraint.drop")

    const dropChild = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${child}/drop`,
      { confirm: `${schema}.${child}` },
      nextKey(),
    )
    expectMutationOk(dropChild, "schema.table.drop")
    expect(await tableExists(child)).toBe(false)
  })

  it("refuses structural mutations on exposed tables through the safe envelope", async () => {
    const table = await fixtureTable("exposure")
    // Enable + force RLS and install the four ownership policies, then
    // expose the table and watch the 9C003 guard refuse a structural change.
    await enableOwnership(table)

    const expose = await adminMutate(
      `/v1/admin/schema/exposure`,
      { schema, table, alias },
      nextKey(),
    )
    expectMutationOk(expose, "schema.exposure.expose")

    // The data API now serves the alias.
    const user = await registerUser(context.api, `b6-owner-${run}@example.com`)
    const listed = await context.api.get(`/v1/data/${alias}`, user.token)
    if (listed.status !== 200) {
      throw new Error(
        `exposed alias unreachable: ${listed.status} ${listed.text}`,
      )
    }

    // Structural mutation of an exposed table fails closed with the
    // generalized 9C003 envelope; no SQL crosses the boundary.
    const structural = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns`,
      {
        column: {
          name: "late",
          type: "text",
          nullable: true,
          default: { kind: "none" },
        },
      },
      nextKey(),
    )
    expectError(structural, 409, "CONFLICT")
    expect(structural.text).toContain(
      "Table is exposed to the data API and must be unexposed before it can be mutated",
    )
    expectNoSqlLeakage(structural)

    // Exposure state is visible in the snapshot.
    const detail = await adminGet(`/v1/admin/schema/tables/${schema}/${table}`)
    expect(
      (detail.body as { data: { exposure: unknown } }).data.exposure,
    ).toEqual({ exposed: true, alias })

    // Unexpose revokes reachability without dropping the table.
    const unexpose = await adminMutate(
      `/v1/admin/schema/unexpose`,
      { schema, table },
      nextKey(),
    )
    expectMutationOk(unexpose, "schema.exposure.unexpose")
    const gone = await context.api.get(`/v1/data/${alias}`, user.token)
    expectError(gone, 404, "TABLE_NOT_FOUND")
    const stillThere = await adminGet(
      `/v1/admin/schema/tables/${schema}/${table}`,
    )
    expect(stillThere.status).toBe(200)
    expect(
      (stillThere.body as { data: { exposure: unknown } }).data.exposure,
    ).toEqual({ exposed: false, alias: null })
  })

  it("removes ownership policies and disables RLS only with confirmation", async () => {
    const table = await fixtureTable("policies")
    await enableOwnership(table)
    const remove = await adminMutate(
      `/v1/admin/schema/policies/remove`,
      { schema, table, column: "owner_id", template: "delete" },
      nextKey(),
    )
    expectMutationOk(remove, "schema.policy.remove")

    const recreate = await adminMutate(
      `/v1/admin/schema/policies`,
      { schema, table, column: "owner_id", template: "delete" },
      nextKey(),
    )
    expectMutationOk(recreate, "schema.policy.create")

    const wrongConfirm = await adminMutate(
      `/v1/admin/schema/rls/disable`,
      { schema, table, confirm: "wrong-value" },
      nextKey(),
    )
    expectError(wrongConfirm, 400, "VALIDATION_ERROR")
    expectNoSqlLeakage(wrongConfirm)

    const disable = await adminMutate(
      `/v1/admin/schema/rls/disable`,
      { schema, table, confirm: `${schema}.${table}` },
      nextKey(),
    )
    expectMutationOk(disable, "schema.rls.disable")

    const detail = await adminGet(`/v1/admin/schema/tables/${schema}/${table}`)
    const data = (detail.body as { data: Record<string, unknown> }).data
    expect(data.hasRowSecurity).toBe(false)
    expect(data.hasForcedRowSecurity).toBe(false)
  })

  it("drops columns and tables only with exact confirmations", async () => {
    const table = await fixtureTable("drop", true)
    const wrongConfirm = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/memo/drop`,
      { confirm: `${schema}.wrong.memo` },
      nextKey(),
    )
    expectError(wrongConfirm, 400, "VALIDATION_ERROR")

    const dropColumn = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/columns/memo/drop`,
      { confirm: `${schema}.${table}.memo` },
      nextKey(),
    )
    expectMutationOk(dropColumn, "schema.column.drop")

    const dropTable = await adminMutate(
      `/v1/admin/schema/tables/${schema}/${table}/drop`,
      { confirm: `${schema}.${table}` },
      nextKey(),
    )
    expectMutationOk(dropTable, "schema.table.drop")
    expect(await tableExists(table)).toBe(false)

    const detail = await adminGet(`/v1/admin/schema/tables/${schema}/${table}`)
    expectError(detail, 404, "TABLE_NOT_FOUND")
  })

  it("never leaks SQL or internals in any admin error body", async () => {
    const responses: ApiResponse[] = [
      await adminGet(`/v1/admin/schema/tables/${schema}/ghost`),
      await adminMutate(
        `/v1/admin/schema/tables/${schema}/nope/columns`,
        {
          column: {
            name: "x",
            type: "text",
            nullable: true,
            default: { kind: "none" },
          },
        },
        nextKey(),
      ),
      await adminMutate(
        "/v1/admin/schema/exposure",
        { schema: "public", table: "ghost", alias: "ghostx" },
        nextKey(),
      ),
      await adminMutate(
        `/v1/admin/schema/tables/${schema}/todos/drop`,
        { confirm: "public.todos" },
        nextKey(),
      ),
    ]
    for (const response of responses) {
      expect(response.status, response.text).toBeGreaterThanOrEqual(400)
      expect(response.status, response.text).toBeLessThan(500)
      expectNoSqlLeakage(response)
    }
  })
})
