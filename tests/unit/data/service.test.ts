import { describe, expect, it, vi } from "vitest"

import type {
  DataRepository,
  ExposedTable,
} from "../../../src/contracts/index.js"
import { createDataService, DataError } from "../../../src/data/index.js"

const identity = { userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
const otherUserId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const id = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const todos: ExposedTable = {
  alias: "todos",
  schema: "public",
  table: "todos",
  primaryKey: "id",
  readableColumns: ["id", "title", "completed", "user_id", "meta"],
  insertableColumns: ["id", "title", "completed", "user_id", "meta"],
  updatableColumns: ["title", "completed", "meta"],
}
const request = { identity, tableAlias: todos.alias }

function setup(table: ExposedTable = todos) {
  const repository = {
    list: vi.fn<DataRepository["list"]>(),
    findById: vi.fn<DataRepository["findById"]>(),
    create: vi.fn<DataRepository["create"]>(),
    updateById: vi.fn<DataRepository["updateById"]>(),
    deleteById: vi.fn<DataRepository["deleteById"]>(),
  }
  const service = createDataService(
    {
      get: (alias) => (alias === table.alias ? table : null),
      list: () => [table],
    },
    repository,
  )
  return { service, repository }
}

const validation = {
  code: "VALIDATION_ERROR",
  status: 400,
  message: "Request validation failed",
}
const missing = { code: "ROW_NOT_FOUND", status: 404, message: "Row not found" }
const bodyError = { body: "Must be a non-empty JSON object" }
const jsonError = { body: "Must contain JSON-compatible values only" }

describe("DataService.list", () => {
  it.each([
    ["default", {}, 50, 0],
    ["minimum", { limit: 1, offset: 0 }, 1, 0],
    ["maximum", { limit: 100, offset: 100_000 }, 100, 100_000],
  ] as const)(
    "forwards %s pagination and returns the repository page",
    async (_case, input, limit, offset) => {
      const { service, repository } = setup()
      const page = { items: [{ id, title: "Alice todo" }], limit, offset }
      repository.list.mockResolvedValue(page)
      expect(await service.list({ ...request, ...input })).toEqual(page)
      expect(repository.list).toHaveBeenCalledExactlyOnceWith({
        identity,
        table: todos,
        limit,
        offset,
      })
    },
  )

  it.each([
    ["limit", 0],
    ["limit", 101],
    ["limit", -1],
    ["limit", 1.5],
    ["limit", "50"],
    ["offset", -1],
    ["offset", 100_001],
    ["offset", 1.5],
    ["offset", "0"],
  ] as const)("rejects %s=%j before reading rows", async (field, value) => {
    const { service, repository } = setup()
    await expect(
      service.list({ ...request, [field]: value }),
    ).rejects.toMatchObject({
      ...validation,
      details: { [field]: expect.any(String) },
    })
    expect(repository.list).not.toHaveBeenCalled()
  })
})

describe("DataService table resolution", () => {
  it.each(["list", "create"] as const)(
    "%s rejects an unknown alias with the public table error",
    async (operation) => {
      const { service, repository } = setup()
      const result = service[operation]({
        identity,
        tableAlias: "missing",
        values: { title: "x" },
      })
      await expect(result).rejects.toBeInstanceOf(DataError)
      await expect(result).rejects.toMatchObject({
        code: "TABLE_NOT_FOUND",
        status: 404,
        message: "Table not found",
      })
      expect(repository[operation]).not.toHaveBeenCalled()
    },
  )
})

describe("DataService row lookup", () => {
  it("gets the requested row in the caller's identity", async () => {
    const { service, repository } = setup()
    const row = { id, title: "Alice todo", completed: true }
    repository.findById.mockResolvedValue(row)
    expect(await service.get({ ...request, id })).toEqual(row)
    expect(repository.findById).toHaveBeenCalledExactlyOnceWith({
      identity,
      table: todos,
      id,
    })
  })

  it("deletes the requested row in the caller's identity", async () => {
    const { service, repository } = setup()
    repository.deleteById.mockResolvedValue(true)
    await expect(service.delete({ ...request, id })).resolves.toBeUndefined()
    expect(repository.deleteById).toHaveBeenCalledExactlyOnceWith({
      identity,
      table: todos,
      id,
    })
  })

  it.each(["get", "update", "delete"] as const)(
    "%s returns the same public error for any invisible row",
    async (operation) => {
      const { service, repository } = setup()
      repository.findById.mockResolvedValue(null)
      repository.updateById.mockResolvedValue(null)
      repository.deleteById.mockResolvedValue(false)
      await expect(
        service[operation]({ ...request, id, values: { title: "x" } }),
      ).rejects.toMatchObject(missing)
    },
  )

  it.each([
    ["get", id.toUpperCase()],
    ["get", "not-a-uuid"],
    ["update", id.toUpperCase()],
    ["delete", "not-a-uuid"],
  ] as const)("%s rejects path ID %s", async (operation, invalidId) => {
    const { service, repository } = setup()
    await expect(
      service[operation]({ ...request, id: invalidId, values: { title: "x" } }),
    ).rejects.toMatchObject({
      ...validation,
      details: { id: "Must be a canonical UUID" },
    })
    expect(repository.findById).not.toHaveBeenCalled()
    expect(repository.updateById).not.toHaveBeenCalled()
    expect(repository.deleteById).not.toHaveBeenCalled()
  })
})

describe("DataService.create", () => {
  it("passes an insertable ID, the caller's ownership claim, and nested JSON to the repository", async () => {
    const { repository, service } = setup()
    const values = {
      id,
      user_id: identity.userId,
      title: "Nested",
      completed: false,
      meta: {
        tags: ["a", "b"],
        scores: [1, 2, 3],
        nested: { ok: true, empty: null },
      },
    }
    const stored = { ...values, created_at: "2026-01-01" }
    repository.create.mockResolvedValue(stored)
    expect(await service.create({ ...request, values })).toEqual(stored)
    expect(repository.create).toHaveBeenCalledExactlyOnceWith({
      identity,
      table: todos,
      values,
    })
  })

  it("lets PostgreSQL supply defaults on tables without an ownership column", async () => {
    const table = {
      ...todos,
      alias: "settings",
      table: "settings",
      readableColumns: ["id", "theme"],
      insertableColumns: ["theme"],
      updatableColumns: ["theme"],
    }
    const { repository, service } = setup(table)
    const values = { theme: "dark" }
    repository.create.mockResolvedValue({ id, ...values })
    expect(
      await service.create({ identity, tableAlias: table.alias, values }),
    ).toEqual({ id, ...values })
    expect(repository.create).toHaveBeenCalledExactlyOnceWith({
      identity,
      table,
      values: { theme: "dark" },
    })
  })

  it.each([
    [
      "uppercase id",
      { id: id.toUpperCase() },
      { id: "Must be a canonical UUID" },
    ],
    ["non-string id", { id: 42 }, { id: "Must be a canonical UUID" }],
    [
      "unknown column",
      { secret_col: "x" },
      { secret_col: "Column is not insertable" },
    ],
    ["empty object", {}, bodyError],
    ["null", null, bodyError],
    ["array", [], bodyError],
    ["string", "string", bodyError],
    ["number", 42, bodyError],
    ["boolean", true, bodyError],
  ] as const)("rejects %s before insert", async (_case, values, details) => {
    const { repository, service } = setup()
    await expect(service.create({ ...request, values })).rejects.toMatchObject({
      ...validation,
      details,
    })
    expect(repository.create).not.toHaveBeenCalled()
  })

  it("rejects an otherwise valid ID when the registry reserves it for the database", async () => {
    const table = { ...todos, insertableColumns: ["title"] }
    const { repository, service } = setup(table)
    await expect(
      service.create({ ...request, values: { id, title: "x" } }),
    ).rejects.toMatchObject({
      ...validation,
      details: { id: "Column is not insertable" },
    })
    expect(repository.create).not.toHaveBeenCalled()
  })

  const cyclic: Record<string, unknown> = {}
  cyclic["self"] = cyclic
  const sparse = [1]
  sparse[2] = 3
  it.each([
    ["Date", new Date()],
    ["Buffer", Buffer.from("hi")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Infinity],
    ["undefined", undefined],
    ["function", () => 1],
    ["cycle", cyclic],
    ["sparse array", sparse],
  ] as const)("rejects nested %s before insert", async (_case, meta) => {
    const { service, repository } = setup()
    await expect(
      service.create({ ...request, values: { title: "x", meta } }),
    ).rejects.toMatchObject({
      ...validation,
      details: jsonError,
    })
    expect(repository.create).not.toHaveBeenCalled()
  })
})

describe("DataService.update", () => {
  it("forwards the path ID, nested patch, and allowed ownership claim and returns the stored row", async () => {
    const table = {
      ...todos,
      updatableColumns: [...todos.updatableColumns, "user_id"],
    }
    const { service, repository } = setup(table)
    const values = {
      title: "New",
      completed: true,
      user_id: identity.userId,
      meta: { tags: [], nested: { deep: [{ x: "y" }] } },
    }
    const row = { id, ...values }
    repository.updateById.mockResolvedValue(row)
    expect(await service.update({ ...request, id, values })).toEqual(row)
    expect(repository.updateById).toHaveBeenCalledExactlyOnceWith({
      identity,
      table,
      id,
      values,
    })
  })

  it.each([
    ["immutable ID", { id }, { id: "Primary key is immutable" }],
    [
      "read-only ownership",
      { user_id: otherUserId },
      { user_id: "Column is not updatable" },
    ],
    ["empty patch", {}, bodyError],
    ["non-JSON value", { meta: new Date() }, jsonError],
  ] as const)("rejects %s before update", async (_case, values, details) => {
    const { service, repository } = setup()
    await expect(
      service.update({ ...request, id, values }),
    ).rejects.toMatchObject({ ...validation, details })
    expect(repository.updateById).not.toHaveBeenCalled()
  })
})

describe("DataService write boundaries", () => {
  it.each([
    ["create", otherUserId],
    ["create", "not-a-user-id"],
    ["update", otherUserId],
  ] as const)(
    "%s rejects ownership claim %s before writing",
    async (operation, userId) => {
      const { service, repository } = setup({
        ...todos,
        updatableColumns: ["title", "user_id"],
      })
      const result = service[operation]({
        ...request,
        id,
        values: { title: "claim", user_id: userId },
      })
      const error: unknown = await result.catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(DataError)
      expect(error).toMatchObject({
        code: "CONFLICT",
        status: 409,
        message: "A conflict occurred",
      })
      expect((error as DataError).details).toBeUndefined()
      expect(repository.create).not.toHaveBeenCalled()
      expect(repository.updateById).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["create", "Column is not insertable"],
    ["update", "Column is not updatable"],
  ] as const)(
    "%s reports the rejected __proto__ key as its own field",
    async (operation, reason) => {
      const { service, repository } = setup()
      const values: unknown = JSON.parse('{"__proto__":"x","title":"ok"}')
      const error: unknown = await service[operation]({
        ...request,
        id,
        values,
      }).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(DataError)
      expect(error).toMatchObject(validation)
      const details = (error as DataError).details
      expect(Object.keys(details ?? {})).toEqual(["__proto__"])
      expect(details?.["__proto__"]).toBe(reason)
      expect(repository.create).not.toHaveBeenCalled()
      expect(repository.updateById).not.toHaveBeenCalled()
    },
  )
})
