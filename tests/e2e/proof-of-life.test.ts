// E2E proof-of-life: healthy health endpoint, the Alice/Bob RLS proof from
// docs/v0.1-scope.md over real HTTP against the compiled server and real
// PostgreSQL RLS, and restart/persistence of sessions and data.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { adminQuery } from "./helpers/database.js"
import {
  createApi,
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
import {
  startE2EServer,
  waitForHealth,
  type RunningServer,
} from "./helpers/server.js"

describe("e2e proof of life", () => {
  let ctx: E2EContext
  let alice: { token: string; userId: string; email: string }
  let bob: { token: string; userId: string; email: string }
  let todoId: string

  beforeAll(async () => {
    ctx = await startE2EFile()
  })

  afterAll(async () => {
    await stopE2EFile(ctx)
  })

  it("reports healthy status and database readiness", async () => {
    const response = await ctx.api.get("/health")

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      data: { status: "ok", database: "ok" },
      error: null,
    })
    expect(response.headers.get("x-request-id")).toBeTruthy()
  })

  it("registers Alice and lets her create, read, and update a todo", async () => {
    alice = await registerUser(ctx.api, `alice-${ctx.run}@example.test`)

    const created = await ctx.api.post(
      "/v1/data/todos",
      { title: "buy milk" },
      alice.token,
    )
    expect(created.status).toBe(201)
    const row = (created.body as { data: Record<string, unknown> }).data
    todoId = row.id as string
    expect(todoId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(row.title).toBe("buy milk")
    expect(row.completed).toBe(false)
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    // Every column the runtime role may SELECT is readable, including the
    // ownership column; RLS evidence: the row belongs to Alice.
    expect(row.user_id).toBe(alice.userId)

    const listed = await ctx.api.get("/v1/data/todos", alice.token)
    expect(listed.status).toBe(200)
    const listedIds = (listed.body as { data: { id: string }[] }).data.map(
      (item) => item.id,
    )
    expect(listedIds).toContain(todoId)

    const fetched = await ctx.api.get(`/v1/data/todos/${todoId}`, alice.token)
    expect(fetched.status).toBe(200)
    expect((fetched.body as { data: { title: string } }).data.title).toBe(
      "buy milk",
    )

    const updated = await ctx.api.patch(
      `/v1/data/todos/${todoId}`,
      { title: "buy oat milk", completed: true },
      alice.token,
    )
    expect(updated.status).toBe(200)
    expect((updated.body as { data: { title: string } }).data.title).toBe(
      "buy oat milk",
    )

    // Independent out-of-band proof the write reached PostgreSQL.
    const stored = await adminQuery<{ title: string; completed: boolean }>(
      "SELECT title, completed FROM public.todos WHERE id = $1",
      [todoId],
    )
    expect(stored.rows).toEqual([{ title: "buy oat milk", completed: true }])
  })

  it("isolates Bob from Alice's todo via PostgreSQL RLS", async () => {
    bob = await registerUser(ctx.api, `bob-${ctx.run}@example.test`)

    const bobList = await ctx.api.get("/v1/data/todos", bob.token)
    expect(bobList.status).toBe(200)
    expect((bobList.body as { data: unknown[] }).data).toEqual([])

    // Hidden row must be indistinguishable from a genuinely missing row.
    const missingId = randomUuid()
    const hiddenGet = await ctx.api.get(`/v1/data/todos/${todoId}`, bob.token)
    const missingGet = await ctx.api.get(
      `/v1/data/todos/${missingId}`,
      bob.token,
    )
    expectError(hiddenGet, 404, "ROW_NOT_FOUND")
    expect(publicError(hiddenGet)).toEqual(publicError(missingGet))

    const hiddenPatch = await ctx.api.patch(
      `/v1/data/todos/${todoId}`,
      { title: "hijacked" },
      bob.token,
    )
    const missingPatch = await ctx.api.patch(
      `/v1/data/todos/${missingId}`,
      { title: "hijacked" },
      bob.token,
    )
    expectError(hiddenPatch, 404, "ROW_NOT_FOUND")
    expect(publicError(hiddenPatch)).toEqual(publicError(missingPatch))

    const hiddenDelete = await ctx.api.del(
      `/v1/data/todos/${todoId}`,
      bob.token,
    )
    const missingDelete = await ctx.api.del(
      `/v1/data/todos/${missingId}`,
      bob.token,
    )
    expectError(hiddenDelete, 404, "ROW_NOT_FOUND")
    expect(publicError(hiddenDelete)).toEqual(publicError(missingDelete))

    // RLS also blocks the write itself, not just the response.
    const stored = await adminQuery(
      "SELECT title FROM public.todos WHERE id = $1",
      [todoId],
    )
    expect(stored.rows[0]?.title).toBe("buy oat milk")
  })

  it("keeps Alice fully functional and able to delete her own todo", async () => {
    const fetched = await ctx.api.get(`/v1/data/todos/${todoId}`, alice.token)
    expect(fetched.status).toBe(200)

    const deleted = await ctx.api.del(`/v1/data/todos/${todoId}`, alice.token)
    expect(deleted.status).toBe(204)
    expect(deleted.text).toBe("")

    const gone = await ctx.api.get(`/v1/data/todos/${todoId}`, alice.token)
    expectError(gone, 404, "ROW_NOT_FOUND")

    // Bob's view never contained the row.
    const bobList = await ctx.api.get("/v1/data/todos", bob.token)
    expect((bobList.body as { data: unknown[] }).data).toEqual([])
  })

  it("preserves sessions and data across a full server restart", async () => {
    // Fresh state for this scenario.
    alice = await registerUser(ctx.api, `alice2-${ctx.run}@example.test`)
    const created = await ctx.api.post(
      "/v1/data/todos",
      { title: "survive restart" },
      alice.token,
    )
    const rowId = (created.body as { data: { id: string } }).data.id

    await ctx.server.stop()
    expect(ctx.server.process.exitCode).toBe(0)

    const restarted: RunningServer = await startE2EServer()
    try {
      await waitForHealth(restarted)
      const newApi = createApi(restarted.baseUrl)

      // The old bearer session is still valid.
      const me = await newApi.get("/v1/auth/me", alice.token)
      expect(me.status).toBe(200)
      expect((me.body as { data: { id: string } }).data.id).toBe(alice.userId)

      // The data is still there.
      const fetched = await newApi.get(`/v1/data/todos/${rowId}`, alice.token)
      expect(fetched.status).toBe(200)

      // Login works too.
      const login = await newApi.post("/v1/auth/login", {
        email: alice.email,
        password: "correct horse battery staple",
      })
      expect(login.status).toBe(200)

      // RLS still applies after restart.
      const bob2 = await registerUser(newApi, `bob2-${ctx.run}@example.test`)
      const blocked = await newApi.get(`/v1/data/todos/${rowId}`, bob2.token)
      expectError(blocked, 404, "ROW_NOT_FOUND")

      await restarted.stop()
      expect(restarted.process.exitCode).toBe(0)
      ctx.server = restarted
    } catch (error) {
      await restarted.stop().catch(() => undefined)
      throw error
    }
  })
})
