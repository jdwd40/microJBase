// E2E pagination and data-error acceptance: pagination bounds and ordering,
// table/UUID/row error cases, body validation, immutability, and the
// constraint-conflict mapping — all through the real HTTP API.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { adminQuery } from "./helpers/database.js"
import {
  expectError,
  publicError,
  randomUuid,
  registerUser,
} from "./helpers/http.js"
import {
  startE2EFile,
  stopE2EFile,
  type E2EContext,
} from "./helpers/lifecycle.js"

describe("e2e pagination and data errors", () => {
  let ctx: E2EContext
  let alice: { token: string; userId: string; email: string }
  let bob: { token: string; userId: string; email: string }
  let aliceRowId: string

  beforeAll(async () => {
    ctx = await startE2EFile()
    alice = await registerUser(ctx.api, `ivy-${ctx.run}@example.test`)
    bob = await registerUser(ctx.api, `judy-${ctx.run}@example.test`)

    // HTTP create is proven here; the remaining rows for the pagination
    // fixture are seeded with admin SQL because it is materially faster and
    // exercises the same list surface. 119 seeds + 1 HTTP row = 120 total.
    const created = await ctx.api.post(
      "/v1/data/todos",
      { title: "http-created" },
      alice.token,
    )
    expect(created.status).toBe(201)
    aliceRowId = (created.body as { data: { id: string } }).data.id

    await adminQuery(
      `INSERT INTO public.todos (user_id, title)
       SELECT $1::uuid, 'seed-' || g FROM generate_series(1, 119) AS g`,
      [alice.userId],
    )
  })

  afterAll(async () => {
    await stopE2EFile(ctx)
  })

  it("paginates with default limit 50 and reports meta", async () => {
    const response = await ctx.api.get("/v1/data/todos", alice.token)

    expect(response.status).toBe(200)
    const body = response.body as {
      data: { id: string }[]
      error: null
      meta: { limit: number; offset: number }
    }
    expect(body.error).toBeNull()
    expect(body.data).toHaveLength(50)
    expect(body.meta).toEqual({ limit: 50, offset: 0 })
  })

  it("returns rows in stable ascending id order", async () => {
    const first = await ctx.api.get(
      "/v1/data/todos?limit=100&offset=0",
      alice.token,
    )
    const second = await ctx.api.get(
      "/v1/data/todos?limit=100&offset=100",
      alice.token,
    )

    const ids = [
      ...(first.body as { data: { id: string }[] }).data,
      ...(second.body as { data: { id: string }[] }).data,
    ].map((row) => row.id)

    expect(ids).toHaveLength(120)
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })

  it("honours valid limit and offset combinations", async () => {
    const limit100 = await ctx.api.get("/v1/data/todos?limit=100", alice.token)
    expect((limit100.body as { data: unknown[] }).data).toHaveLength(100)
    expect((limit100.body as { meta: unknown }).meta).toEqual({
      limit: 100,
      offset: 0,
    })

    const page = await ctx.api.get(
      "/v1/data/todos?limit=10&offset=115",
      alice.token,
    )
    expect((page.body as { data: unknown[] }).data).toHaveLength(5)
    expect((page.body as { meta: unknown }).meta).toEqual({
      limit: 10,
      offset: 115,
    })
  })

  it("rejects out-of-bounds and non-integer pagination with 400", async () => {
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=abc",
      "limit=1.5",
      "offset=-1",
      "offset=100001",
      "offset=xyz",
    ]) {
      const response = await ctx.api.get(`/v1/data/todos?${query}`, alice.token)
      expectError(response, 400, "VALIDATION_ERROR")
    }
  })

  it("maps unknown tables, malformed UUIDs, and missing rows correctly", async () => {
    const unknownTable = await ctx.api.get("/v1/data/secrets", alice.token)
    expectError(unknownTable, 404, "TABLE_NOT_FOUND")

    const malformed = await ctx.api.get(
      "/v1/data/todos/not-a-uuid",
      alice.token,
    )
    expectError(malformed, 400, "VALIDATION_ERROR")

    // Uppercase UUID is not canonical per the frozen contract.
    const uppercase = await ctx.api.get(
      `/v1/data/todos/${aliceRowId.toUpperCase()}`,
      alice.token,
    )
    expectError(uppercase, 400, "VALIDATION_ERROR")

    const missing = await ctx.api.get(
      `/v1/data/todos/${randomUuid()}`,
      alice.token,
    )
    expectError(missing, 404, "ROW_NOT_FOUND")
  })

  it("makes an RLS-hidden row indistinguishable from a missing row", async () => {
    const hidden = await ctx.api.get(`/v1/data/todos/${aliceRowId}`, bob.token)
    const missing = await ctx.api.get(
      `/v1/data/todos/${randomUuid()}`,
      bob.token,
    )

    expectError(hidden, 404, "ROW_NOT_FOUND")
    expect(publicError(hidden)).toEqual(publicError(missing))
  })

  it("rejects empty create and patch bodies with 400", async () => {
    const emptyCreate = await ctx.api.post("/v1/data/todos", {}, alice.token)
    expectError(emptyCreate, 400, "VALIDATION_ERROR")

    const emptyPatch = await ctx.api.patch(
      `/v1/data/todos/${aliceRowId}`,
      {},
      alice.token,
    )
    expectError(emptyPatch, 400, "VALIDATION_ERROR")
  })

  it("rejects patching the immutable primary key", async () => {
    const response = await ctx.api.patch(
      `/v1/data/todos/${aliceRowId}`,
      { id: randomUuid() },
      alice.token,
    )
    expectError(response, 400, "VALIDATION_ERROR")
  })

  it("rejects unknown columns on create and patch", async () => {
    const create = await ctx.api.post(
      "/v1/data/todos",
      { title: "x", nope: 1 },
      alice.token,
    )
    expectError(create, 400, "VALIDATION_ERROR")

    const patch = await ctx.api.patch(
      `/v1/data/todos/${aliceRowId}`,
      { nope: 1 },
      alice.token,
    )
    expectError(patch, 400, "VALIDATION_ERROR")
  })

  it("accepts an explicit valid UUID and maps duplicates to 409 CONFLICT", async () => {
    const explicitId = randomUuid()
    const first = await ctx.api.post(
      "/v1/data/todos",
      { id: explicitId, title: "explicit" },
      alice.token,
    )
    expect(first.status).toBe(201)
    expect((first.body as { data: { id: string } }).data.id).toBe(explicitId)

    const duplicate = await ctx.api.post(
      "/v1/data/todos",
      { id: explicitId, title: "duplicate" },
      alice.token,
    )
    expectError(duplicate, 409, "CONFLICT")

    const nonUuid = await ctx.api.post(
      "/v1/data/todos",
      { id: "not-a-uuid", title: "bad id" },
      alice.token,
    )
    expectError(nonUuid, 400, "VALIDATION_ERROR")
  })

  it("never leaks raw database error text on constraint violations", async () => {
    // 501-char title violates the CHECK constraint; it maps to the safe
    // generic conflict without leaking constraint internals.
    const response = await ctx.api.post(
      "/v1/data/todos",
      { title: "x".repeat(501) },
      alice.token,
    )

    expectError(response, 409, "CONFLICT")
    const text = response.text
    for (const forbidden of [
      "SQLSTATE",
      "23514",
      "todos_title_check",
      "FATAL",
    ]) {
      expect(text).not.toContain(forbidden)
    }
  })
})
