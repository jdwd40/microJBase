import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import type {
  DataRepository,
  DataRow,
  ExposedTable,
  JsonValue,
  Page,
  RequestIdentity,
  TableRegistry,
} from "../../../src/contracts/index.js"
import { DataError, createDataService } from "../../../src/data/index.js"

const TODOS: ExposedTable = {
  alias: "todos",
  schema: "public",
  table: "todos",
  primaryKey: "id",
  readableColumns: [
    "id",
    "title",
    "completed",
    "user_id",
    "meta",
    "created_at",
  ],
  insertableColumns: ["id", "title", "completed", "user_id", "meta"],
  updatableColumns: ["title", "completed", "meta"],
}

const PROFILES: ExposedTable = {
  alias: "profiles",
  schema: "public",
  table: "profiles",
  primaryKey: "id",
  readableColumns: ["id", "display_name", "user_id"],
  // id not insertable — database default only
  insertableColumns: ["display_name", "user_id"],
  updatableColumns: ["display_name"],
}

// Table whose ownership column is also updatable (as the runtime role's
// table-level UPDATE grant makes it in the real registry).
const NOTES: ExposedTable = {
  alias: "notes",
  schema: "public",
  table: "notes",
  primaryKey: "id",
  readableColumns: ["id", "title", "user_id"],
  insertableColumns: ["title", "user_id"],
  updatableColumns: ["title", "user_id"],
}

// Table with no ownership column at all.
const SETTINGS: ExposedTable = {
  alias: "settings",
  schema: "public",
  table: "settings",
  primaryKey: "id",
  readableColumns: ["id", "theme"],
  insertableColumns: ["theme"],
  updatableColumns: ["theme"],
}

class FakeTableRegistry implements TableRegistry {
  private readonly tables: Map<string, ExposedTable>

  constructor(tables: ExposedTable[]) {
    this.tables = new Map(tables.map((t) => [t.alias, t]))
  }

  get(alias: string): ExposedTable | null {
    return this.tables.get(alias) ?? null
  }

  list(): readonly ExposedTable[] {
    return [...this.tables.values()]
  }
}

type StoredRow = DataRow & { _ownerId: string }

class FakeDataRepository implements DataRepository {
  rows = new Map<string, StoredRow[]>() // key: alias

  seed(alias: string, ownerId: string, row: DataRow): DataRow {
    const stored: StoredRow = { ...row, _ownerId: ownerId }
    const list = this.rows.get(alias) ?? []
    list.push(stored)
    this.rows.set(alias, list)
    return this.publicRow(stored)
  }

  private publicRow(stored: StoredRow): DataRow {
    const { _ownerId, ...rest } = stored
    void _ownerId
    return rest
  }

  private owned(alias: string, identity: RequestIdentity): StoredRow[] {
    return (this.rows.get(alias) ?? []).filter(
      (r) => r._ownerId === identity.userId,
    )
  }

  async list(input: {
    identity: RequestIdentity
    table: ExposedTable
    limit: number
    offset: number
  }): Promise<Page<DataRow>> {
    const owned = this.owned(input.table.alias, input.identity)
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
    const row = this.owned(input.table.alias, input.identity).find(
      (r) => r["id"] === input.id,
    )
    return row ? this.publicRow(row) : null
  }

  async create(input: {
    identity: RequestIdentity
    table: ExposedTable
    values: DataRow
  }): Promise<DataRow> {
    const id =
      typeof input.values["id"] === "string" ? input.values["id"] : randomUUID()
    const row: DataRow = {
      ...input.values,
      id,
      user_id: input.identity.userId,
    }
    return this.seed(input.table.alias, input.identity.userId, row)
  }

  async updateById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
    values: DataRow
  }): Promise<DataRow | null> {
    const list = this.rows.get(input.table.alias) ?? []
    const idx = list.findIndex(
      (r) => r["id"] === input.id && r._ownerId === input.identity.userId,
    )
    if (idx < 0) return null
    const existing = list[idx]!
    const updated: StoredRow = {
      ...existing,
      ...input.values,
      id: existing["id"] as JsonValue,
      _ownerId: existing._ownerId,
    }
    list[idx] = updated
    return this.publicRow(updated)
  }

  async deleteById(input: {
    identity: RequestIdentity
    table: ExposedTable
    id: string
  }): Promise<boolean> {
    const list = this.rows.get(input.table.alias) ?? []
    const idx = list.findIndex(
      (r) => r["id"] === input.id && r._ownerId === input.identity.userId,
    )
    if (idx < 0) return false
    list.splice(idx, 1)
    return true
  }
}

const ALICE: RequestIdentity = {
  userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
}
const BOB: RequestIdentity = {
  userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
}

function build() {
  const registry = new FakeTableRegistry([TODOS, PROFILES, NOTES, SETTINGS])
  const repository = new FakeDataRepository()
  const service = createDataService(registry, repository)
  return { service, repository, registry }
}

function buildWithWriteSpies() {
  const built = build()
  let createCalls = 0
  let updateCalls = 0
  const originalCreate = built.repository.create.bind(built.repository)
  const originalUpdate = built.repository.updateById.bind(built.repository)
  built.repository.create = async (input) => {
    createCalls += 1
    return originalCreate(input)
  }
  built.repository.updateById = async (input) => {
    updateCalls += 1
    return originalUpdate(input)
  }
  return {
    ...built,
    createCalls: () => createCalls,
    updateCalls: () => updateCalls,
  }
}

/** Spies that capture the exact values reaching the repository. */
function buildWithWriteCapture() {
  const built = build()
  let createdValues: DataRow | null = null
  let updatedValues: DataRow | null = null
  const originalCreate = built.repository.create.bind(built.repository)
  const originalUpdate = built.repository.updateById.bind(built.repository)
  built.repository.create = async (input) => {
    createdValues = input.values
    return originalCreate(input)
  }
  built.repository.updateById = async (input) => {
    updatedValues = input.values
    return originalUpdate(input)
  }
  return {
    ...built,
    createdValues: () => createdValues,
    updatedValues: () => updatedValues,
  }
}

describe("DataService", () => {
  describe("list", () => {
    it("returns owned rows with default limit/offset", async () => {
      const { service, repository } = build()
      repository.seed("todos", ALICE.userId, {
        id: "11111111-1111-1111-1111-111111111111",
        title: "Alice todo",
        completed: false,
      })
      repository.seed("todos", BOB.userId, {
        id: "22222222-2222-2222-2222-222222222222",
        title: "Bob todo",
        completed: false,
      })

      const page = await service.list({
        identity: ALICE,
        tableAlias: "todos",
      })
      expect(page.limit).toBe(50)
      expect(page.offset).toBe(0)
      expect(page.items).toHaveLength(1)
      expect(page.items[0]?.["title"]).toBe("Alice todo")
    })

    it("accepts boundary limit/offset values", async () => {
      const { service } = build()
      for (const limit of [1, 100]) {
        const page = await service.list({
          identity: ALICE,
          tableAlias: "todos",
          limit,
          offset: 0,
        })
        expect(page.limit).toBe(limit)
      }
      for (const offset of [0, 100_000]) {
        const page = await service.list({
          identity: ALICE,
          tableAlias: "todos",
          limit: 1,
          offset,
        })
        expect(page.offset).toBe(offset)
      }
    })

    it.each([
      { limit: 0 },
      { limit: 101 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: "50" as unknown as number },
    ])("rejects invalid limit %j", async ({ limit }) => {
      const { service } = build()
      await expect(
        service.list({ identity: ALICE, tableAlias: "todos", limit }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({ limit: expect.any(String) }),
      })
    })

    it.each([
      { offset: -1 },
      { offset: 100_001 },
      { offset: 1.5 },
      { offset: "0" as unknown as number },
    ])("rejects invalid offset %j", async ({ offset }) => {
      const { service } = build()
      await expect(
        service.list({ identity: ALICE, tableAlias: "todos", offset }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({ offset: expect.any(String) }),
      })
    })

    it("returns TABLE_NOT_FOUND for unknown alias", async () => {
      const { service } = build()
      await expect(
        service.list({ identity: ALICE, tableAlias: "secrets" }),
      ).rejects.toMatchObject({
        code: "TABLE_NOT_FOUND",
        status: 404,
        message: "Table not found",
      })
    })
  })

  describe("get", () => {
    it("returns a row by id", async () => {
      const { service, repository } = build()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Get me",
        completed: true,
      })
      const row = await service.get({
        identity: ALICE,
        tableAlias: "todos",
        id,
      })
      expect(row["title"]).toBe("Get me")
      expect(row["completed"]).toBe(true)
    })

    it("rejects uppercase UUID", async () => {
      const { service } = build()
      await expect(
        service.get({
          identity: ALICE,
          tableAlias: "todos",
          id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({ id: expect.any(String) }),
      })
    })

    it("rejects malformed UUID", async () => {
      const { service } = build()
      await expect(
        service.get({
          identity: ALICE,
          tableAlias: "todos",
          id: "not-a-uuid",
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
      })
    })

    it("returns ROW_NOT_FOUND for missing row", async () => {
      const { service } = build()
      await expect(
        service.get({
          identity: ALICE,
          tableAlias: "todos",
          id: "11111111-1111-1111-1111-111111111111",
        }),
      ).rejects.toMatchObject({
        code: "ROW_NOT_FOUND",
        status: 404,
        message: "Row not found",
      })
    })

    it("returns ROW_NOT_FOUND for RLS-hidden row (same as missing)", async () => {
      const { service, repository } = build()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Alice only",
        completed: false,
      })
      await expect(
        service.get({ identity: BOB, tableAlias: "todos", id }),
      ).rejects.toMatchObject({
        code: "ROW_NOT_FOUND",
        status: 404,
      })
    })
  })

  describe("create", () => {
    it("creates a row with validated values", async () => {
      const { service } = build()
      const row = await service.create({
        identity: ALICE,
        tableAlias: "todos",
        values: { title: "New todo", completed: false },
      })
      expect(row["title"]).toBe("New todo")
      expect(typeof row["id"]).toBe("string")
    })

    it("accepts optional canonical id when insertable", async () => {
      const { service } = build()
      const id = "cccccccc-cccc-cccc-cccc-cccccccccccc"
      const row = await service.create({
        identity: ALICE,
        tableAlias: "todos",
        values: { id, title: "With id", completed: false },
      })
      expect(row["id"]).toBe(id)
    })

    it("rejects non-insertable id column when not in insertableColumns", async () => {
      const { service } = build()
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "profiles",
          values: {
            id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
            display_name: "Alice",
          },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({
          id: "Column is not insertable",
        }),
      })
    })

    it("rejects uppercase id on create", async () => {
      const { service } = build()
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "todos",
          values: {
            id: "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
            title: "Bad id",
          },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({ id: "Must be a canonical UUID" }),
      })
    })

    it("accepts nested JSON on an insertable column", async () => {
      const { service } = build()
      const meta = { tags: ["a", "b"], nested: { n: 1 } }
      const row = await service.create({
        identity: ALICE,
        tableAlias: "todos",
        values: { title: "Nested", meta },
      })
      expect(row["meta"]).toEqual(meta)
    })

    it("rejects unknown/non-insertable columns", async () => {
      const { service } = build()
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "todos",
          values: { title: "x", secret_col: "nope" },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({
          secret_col: "Column is not insertable",
        }),
      })
    })

    it("rejects empty object payload", async () => {
      const { service } = build()
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "todos",
          values: {},
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({ body: expect.any(String) }),
      })
    })

    it.each([null, [], "string", 42, true])(
      "rejects non-object payload %j",
      async (values) => {
        const { service } = build()
        await expect(
          service.create({
            identity: ALICE,
            tableAlias: "todos",
            values,
          }),
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          status: 400,
        })
      },
    )

    it("returns TABLE_NOT_FOUND for unknown alias", async () => {
      const { service } = build()
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "nope",
          values: { title: "x" },
        }),
      ).rejects.toMatchObject({
        code: "TABLE_NOT_FOUND",
        status: 404,
      })
    })
  })

  describe("update", () => {
    it("updates updatable columns", async () => {
      const { service, repository } = build()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Old",
        completed: false,
      })
      const row = await service.update({
        identity: ALICE,
        tableAlias: "todos",
        id,
        values: { title: "New", completed: true },
      })
      expect(row["title"]).toBe("New")
      expect(row["completed"]).toBe(true)
    })

    it("rejects immutable id in body", async () => {
      const { service, repository } = build()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Old",
        completed: false,
      })
      await expect(
        service.update({
          identity: ALICE,
          tableAlias: "todos",
          id,
          values: { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", title: "x" },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({
          id: "Primary key is immutable",
        }),
      })
    })

    it("rejects non-updatable columns", async () => {
      const { service, repository } = build()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Old",
        completed: false,
      })
      await expect(
        service.update({
          identity: ALICE,
          tableAlias: "todos",
          id,
          values: { user_id: BOB.userId },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: expect.objectContaining({
          user_id: "Column is not updatable",
        }),
      })
    })

    it("rejects empty patch body", async () => {
      const { service } = build()
      await expect(
        service.update({
          identity: ALICE,
          tableAlias: "todos",
          id: "11111111-1111-1111-1111-111111111111",
          values: {},
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
      })
    })

    it("returns ROW_NOT_FOUND when missing", async () => {
      const { service } = build()
      await expect(
        service.update({
          identity: ALICE,
          tableAlias: "todos",
          id: "11111111-1111-1111-1111-111111111111",
          values: { title: "x" },
        }),
      ).rejects.toMatchObject({
        code: "ROW_NOT_FOUND",
        status: 404,
      })
    })

    it("returns ROW_NOT_FOUND for hidden row", async () => {
      const { service, repository } = build()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Alice",
        completed: false,
      })
      await expect(
        service.update({
          identity: BOB,
          tableAlias: "todos",
          id,
          values: { title: "hacked" },
        }),
      ).rejects.toMatchObject({
        code: "ROW_NOT_FOUND",
        status: 404,
      })
    })

    it("rejects uppercase path id", async () => {
      const { service } = build()
      await expect(
        service.update({
          identity: ALICE,
          tableAlias: "todos",
          id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
          values: { title: "x" },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
      })
    })
  })

  describe("ownership binding", () => {
    it("rejects a foreign user_id claim on create before any repository call", async () => {
      const { service, createCalls } = buildWithWriteSpies()
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "todos",
          values: { title: "claim", user_id: BOB.userId },
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
        message: "A conflict occurred",
      })
      expect(createCalls()).toBe(0)
    })

    it("rejects a foreign user_id claim on update before any repository call", async () => {
      const { service, repository, updateCalls } = buildWithWriteSpies()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("notes", ALICE.userId, {
        id,
        title: "Mine",
        user_id: ALICE.userId,
      })
      await expect(
        service.update({
          identity: ALICE,
          tableAlias: "notes",
          id,
          values: { user_id: BOB.userId },
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
        message: "A conflict occurred",
      })
      expect(updateCalls()).toBe(0)
    })

    it("rejects any non-identity user_id value, not just other users' ids", async () => {
      const { service, createCalls } = buildWithWriteSpies()
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "todos",
          values: { title: "claim", user_id: "not-a-user-id" },
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
      })
      expect(createCalls()).toBe(0)
    })

    it("lets a client name their own user_id on create", async () => {
      const { service, createdValues } = buildWithWriteCapture()
      const row = await service.create({
        identity: ALICE,
        tableAlias: "todos",
        values: { title: "mine", user_id: ALICE.userId },
      })
      expect(row["title"]).toBe("mine")
      expect(createdValues()?.["user_id"]).toBe(ALICE.userId)
    })

    it("lets a client re-assert their own user_id on update when updatable", async () => {
      const { service, repository, updatedValues } = buildWithWriteCapture()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("notes", ALICE.userId, {
        id,
        title: "Mine",
        user_id: ALICE.userId,
      })
      const row = await service.update({
        identity: ALICE,
        tableAlias: "notes",
        id,
        values: { title: "still mine", user_id: ALICE.userId },
      })
      expect(row["title"]).toBe("still mine")
      expect(updatedValues()?.["user_id"]).toBe(ALICE.userId)
    })

    it("does not invent a user_id for tables without an ownership column", async () => {
      const { service, createdValues } = buildWithWriteCapture()
      await service.create({
        identity: ALICE,
        tableAlias: "settings",
        values: { theme: "dark" },
      })
      expect(createdValues()).not.toBeNull()
      expect(
        Object.prototype.hasOwnProperty.call(createdValues() ?? {}, "user_id"),
      ).toBe(false)
    })

    it("emits the conflict without field details so nothing about the attempt leaks", async () => {
      const { service } = build()
      try {
        await service.create({
          identity: ALICE,
          tableAlias: "todos",
          values: { title: "claim", user_id: BOB.userId },
        })
        expect.unreachable("should throw")
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DataError)
        const err = error as DataError
        expect(err.code).toBe("CONFLICT")
        expect(err.status).toBe(409)
        expect(err.message).toBe("A conflict occurred")
        expect(err.details).toBeUndefined()
      }
    })
  })

  describe("delete", () => {
    it("deletes an owned row", async () => {
      const { service, repository } = build()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Gone",
        completed: false,
      })
      await expect(
        service.delete({ identity: ALICE, tableAlias: "todos", id }),
      ).resolves.toBeUndefined()
      await expect(
        service.get({ identity: ALICE, tableAlias: "todos", id }),
      ).rejects.toMatchObject({ code: "ROW_NOT_FOUND" })
    })

    it("returns ROW_NOT_FOUND when missing", async () => {
      const { service } = build()
      await expect(
        service.delete({
          identity: ALICE,
          tableAlias: "todos",
          id: "11111111-1111-1111-1111-111111111111",
        }),
      ).rejects.toMatchObject({
        code: "ROW_NOT_FOUND",
        status: 404,
      })
    })

    it("returns ROW_NOT_FOUND for hidden row", async () => {
      const { service, repository } = build()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Alice",
        completed: false,
      })
      await expect(
        service.delete({ identity: BOB, tableAlias: "todos", id }),
      ).rejects.toMatchObject({
        code: "ROW_NOT_FOUND",
        status: 404,
      })
    })

    it("rejects invalid UUID", async () => {
      const { service } = build()
      await expect(
        service.delete({
          identity: ALICE,
          tableAlias: "todos",
          id: "BAD",
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
      })
    })
  })

  describe("JSON value boundary", () => {
    it("accepts nested objects and arrays on create and update", async () => {
      const { service, repository } = build()
      const meta = {
        tags: ["a", "b"],
        nested: { n: 1, ok: true, empty: null },
        scores: [1, 2, 3],
      }
      const created = await service.create({
        identity: ALICE,
        tableAlias: "todos",
        values: { title: "Nested", meta },
      })
      expect(created["meta"]).toEqual(meta)

      const id = String(created["id"])
      const updatedMeta = { tags: [], nested: { deep: [{ x: "y" }] } }
      const updated = await service.update({
        identity: ALICE,
        tableAlias: "todos",
        id,
        values: { meta: updatedMeta },
      })
      expect(updated["meta"]).toEqual(updatedMeta)
      void repository
    })

    it.each([
      { label: "Date", values: { title: "x", meta: new Date() } },
      { label: "Buffer", values: { title: "x", meta: Buffer.from("hi") } },
      { label: "bigint", values: { title: "x", meta: 1n } },
      { label: "NaN", values: { title: "x", meta: Number.NaN } },
      {
        label: "Infinity",
        values: { title: "x", meta: Number.POSITIVE_INFINITY },
      },
      { label: "undefined", values: { title: "x", meta: undefined } },
      { label: "function", values: { title: "x", meta: () => 1 } },
    ])(
      "rejects non-JSON $label on create and does not call repository",
      async ({ values }) => {
        const { service, createCalls } = buildWithWriteSpies()
        await expect(
          service.create({ identity: ALICE, tableAlias: "todos", values }),
        ).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          status: 400,
          details: { body: "Must contain JSON-compatible values only" },
        })
        expect(createCalls()).toBe(0)
      },
    )

    it("rejects cyclic nested objects on create without calling repository", async () => {
      const { service, createCalls } = buildWithWriteSpies()
      const cyclic: Record<string, unknown> = { title: "x" }
      cyclic["meta"] = cyclic
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "todos",
          values: cyclic,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
      })
      expect(createCalls()).toBe(0)
    })

    it("rejects array holes on create without calling repository", async () => {
      const { service, createCalls } = buildWithWriteSpies()
      const holey = [1]
      holey[2] = 3
      await expect(
        service.create({
          identity: ALICE,
          tableAlias: "todos",
          values: { title: "x", meta: holey },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
      })
      expect(createCalls()).toBe(0)
    })

    it("rejects non-JSON values on update without calling repository", async () => {
      const { service, repository, updateCalls } = buildWithWriteSpies()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Seed",
        completed: false,
      })
      await expect(
        service.update({
          identity: ALICE,
          tableAlias: "todos",
          id,
          values: { meta: new Date() },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        status: 400,
        details: { body: "Must contain JSON-compatible values only" },
      })
      expect(updateCalls()).toBe(0)
    })
  })

  describe("__proto__ column bypass", () => {
    it("rejects __proto__ on create and does not call repository", async () => {
      const { service, createCalls } = buildWithWriteSpies()
      const values = JSON.parse('{"__proto__":"x","title":"ok"}') as Record<
        string,
        unknown
      >
      await expect(
        service.create({ identity: ALICE, tableAlias: "todos", values }),
      ).rejects.toThrow(DataError)
      try {
        await service.create({ identity: ALICE, tableAlias: "todos", values })
      } catch (error: unknown) {
        const err = error as DataError
        expect(err.code).toBe("VALIDATION_ERROR")
        expect(err.status).toBe(400)
        expect(
          Object.prototype.hasOwnProperty.call(err.details, "__proto__"),
        ).toBe(true)
        expect(err.details?.["__proto__"]).toBe("Column is not insertable")
      }
      expect(createCalls()).toBe(0)
    })

    it("rejects __proto__ on update and does not call repository", async () => {
      const { service, repository, updateCalls } = buildWithWriteSpies()
      const id = "11111111-1111-1111-1111-111111111111"
      repository.seed("todos", ALICE.userId, {
        id,
        title: "Seed",
        completed: false,
      })
      const values = JSON.parse('{"__proto__":"x"}') as Record<string, unknown>
      await expect(
        service.update({
          identity: ALICE,
          tableAlias: "todos",
          id,
          values,
        }),
      ).rejects.toThrow(DataError)
      try {
        await service.update({
          identity: ALICE,
          tableAlias: "todos",
          id,
          values,
        })
      } catch (error: unknown) {
        const err = error as DataError
        expect(err.code).toBe("VALIDATION_ERROR")
        expect(err.status).toBe(400)
        expect(
          Object.prototype.hasOwnProperty.call(err.details, "__proto__"),
        ).toBe(true)
        expect(err.details?.["__proto__"]).toBe("Column is not updatable")
      }
      expect(updateCalls()).toBe(0)
    })
  })

  describe("errors", () => {
    it("DataError implements AppError shape without leaking SQL", async () => {
      const { service } = build()
      try {
        await service.list({ identity: ALICE, tableAlias: "nope" })
        expect.unreachable("should throw")
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DataError)
        const err = error as DataError
        expect(err.code).toBe("TABLE_NOT_FOUND")
        expect(err.status).toBe(404)
        expect(err.message.toLowerCase()).not.toContain("select")
        expect(err.message.toLowerCase()).not.toContain("sql")
      }
    })
  })
})
