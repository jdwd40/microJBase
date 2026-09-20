import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest"
import pg from "pg"

import {
  buildTableRegistry,
  createPool,
  createPostgresDataRepository,
  createTransactionRunner,
  type Pool,
} from "../../../src/database/index.js"
import type {
  DataRepository,
  ExposedTable,
} from "../../../src/contracts/index.js"
import {
  applyMigrationsAndGrants,
  cleanMigrations,
  withClient,
} from "./bootstrap.js"
import { quoteIdentifier } from "./helpers.js"

const databaseUrl =
  process.env.INTEGRATION_DATABASE_URL ??
  "postgres://microjbase_runtime:***@127.0.0.1:5432/microjbase_dev"

const adminDatabaseUrl =
  process.env.INTEGRATION_ADMIN_DATABASE_URL ??
  process.env.MIGRATION_DATABASE_URL ??
  "postgres://microjbase:***@127.0.0.1:5432/microjbase_dev"

const runtimeRoleName = new URL(databaseUrl).username

const ALICE = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
const BOB = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22"

async function withAdminClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(adminDatabaseUrl, fn)
}

let pool: Pool
let repository: DataRepository

describe("data repository", () => {
  beforeAll(async () => {
    await cleanMigrations(adminDatabaseUrl)
    await applyMigrationsAndGrants(adminDatabaseUrl, runtimeRoleName)
    await withAdminClient(async (admin) => {
      const role = quoteIdentifier(runtimeRoleName)
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO ${role}`,
      )
    })
    pool = createPool({ databaseUrl, maxConnections: 2 })
    const runner = createTransactionRunner(() => pool.connect())
    repository = createPostgresDataRepository({ runner })
  })

  afterAll(async () => {
    await pool.close()
    await cleanMigrations(adminDatabaseUrl)
  })

  async function table(): Promise<ExposedTable> {
    const client = await pool.connect()
    try {
      const registry = await buildTableRegistry(
        { mappings: [{ alias: "todos", schema: "public", table: "todos" }] },
        { query: (text, values) => client.query(text, values) },
      )
      const t = registry.get("todos")
      if (t === null) {
        throw new Error("todos table not found in registry")
      }
      return t
    } finally {
      client.release()
    }
  }

  async function clearTodos(): Promise<void> {
    await withAdminClient(async (admin) => {
      await admin.query("TRUNCATE TABLE public.todos RESTART IDENTITY CASCADE")
    })
  }

  async function insertTodo(
    userId: string,
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const result = await withAdminClient(async (admin) => {
      const rs = await admin.query<{ id: string }>(
        `
          INSERT INTO public.todos (user_id, title, metadata)
          VALUES ($1, $2, $3)
          RETURNING id
        `,
        [userId, title, JSON.stringify(extra.metadata ?? {})],
      )
      return rs.rows[0]?.id
    })
    if (result === undefined) {
      throw new Error("failed to insert todo")
    }
    return result
  }

  describe("CRUD", () => {
    beforeEach(async () => {
      await clearTodos()
    })

    it("lists rows for a user", async () => {
      await insertTodo(ALICE, "alice 1")
      await insertTodo(ALICE, "alice 2")

      const t = await table()
      const page = await repository.list({
        identity: { userId: ALICE },
        table: t,
        limit: 10,
        offset: 0,
      })

      expect(page.items).toHaveLength(2)
      const titles = page.items
        .map((r: Record<string, unknown>) => r.title)
        .sort()
      expect(titles).toEqual(["alice 1", "alice 2"])
      expect(page.limit).toBe(10)
      expect(page.offset).toBe(0)
    })

    it("finds a row by id", async () => {
      const id = await insertTodo(ALICE, "find me")
      const t = await table()
      const row = await repository.findById({
        identity: { userId: ALICE },
        table: t,
        id,
      })
      expect(row).not.toBeNull()
      expect(row?.title).toBe("find me")
    })

    it("creates a row", async () => {
      const t = await table()
      const row = await repository.create({
        identity: { userId: ALICE },
        table: t,
        values: { title: "new todo", priority: 3 },
      })

      expect(row.title).toBe("new todo")
      expect(row.priority).toBe(3)
      expect(typeof row.id).toBe("string")
      expect(row.user_id).toBe(ALICE)
    })

    it("updates a row", async () => {
      const id = await insertTodo(ALICE, "old title")
      const t = await table()
      const row = await repository.updateById({
        identity: { userId: ALICE },
        table: t,
        id,
        values: { title: "new title", completed: true },
      })
      expect(row).not.toBeNull()
      expect(row?.title).toBe("new title")
      expect(row?.completed).toBe(true)
    })

    it("deletes a row", async () => {
      const id = await insertTodo(ALICE, "delete me")
      const t = await table()
      const deleted = await repository.deleteById({
        identity: { userId: ALICE },
        table: t,
        id,
      })
      expect(deleted).toBe(true)

      const row = await repository.findById({
        identity: { userId: ALICE },
        table: t,
        id,
      })
      expect(row).toBeNull()
    })

    it("returns null for missing row", async () => {
      const t = await table()
      const row = await repository.findById({
        identity: { userId: ALICE },
        table: t,
        id: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c33",
      })
      expect(row).toBeNull()
    })

    it("returns false for deleting missing row", async () => {
      const t = await table()
      const deleted = await repository.deleteById({
        identity: { userId: ALICE },
        table: t,
        id: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c33",
      })
      expect(deleted).toBe(false)
    })

    it("returns null for updating missing row", async () => {
      const t = await table()
      const row = await repository.updateById({
        identity: { userId: ALICE },
        table: t,
        id: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c33",
        values: { title: "x" },
      })
      expect(row).toBeNull()
    })

    it("rejects disallowed columns on create", async () => {
      const t = await table()
      await expect(
        repository.create({
          identity: { userId: ALICE },
          table: t,
          values: { title: "x", not_a_column: 1 },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      })
    })

    it("rejects id in update values", async () => {
      const t = await table()
      await expect(
        repository.updateById({
          identity: { userId: ALICE },
          table: t,
          id: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c33",
          values: { id: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380d44", title: "x" },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      })
    })

    it("translates unique violations to safe CONFLICT", async () => {
      const t = await table()
      await repository.create({
        identity: { userId: ALICE },
        table: t,
        values: { title: "unique todo" },
      })

      // There is no unique constraint on title alone; add one temporarily.
      await withAdminClient(async (admin) => {
        await admin.query(
          "CREATE UNIQUE INDEX tmp_todos_title ON public.todos(title)",
        )
      })

      await expect(
        repository.create({
          identity: { userId: ALICE },
          table: t,
          values: { title: "unique todo" },
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "A conflict occurred",
      })

      await withAdminClient(async (admin) => {
        await admin.query("DROP INDEX IF EXISTS tmp_todos_title")
      })
    })
  })

  describe("JSON conversion", () => {
    it("converts supported PostgreSQL types to JSON values", async () => {
      const t = await table()
      const row = await repository.create({
        identity: { userId: ALICE },
        table: t,
        values: {
          title: "conversion test",
          completed: true,
          priority: 7,
          metadata: { tags: ["a", "b"], nested: { value: 1 } },
        },
      })

      expect(typeof row.id).toBe("string")
      expect(typeof row.title).toBe("string")
      expect(typeof row.user_id).toBe("string")
      expect(row.completed).toBe(true)
      expect(row.priority).toBe(7)
      expect(row.metadata).toEqual({ tags: ["a", "b"], nested: { value: 1 } })
      expect(typeof row.created_at).toBe("string")
      expect(typeof row.updated_at).toBe("string")
    })
  })

  describe("RLS isolation", () => {
    beforeEach(async () => {
      await clearTodos()
    })

    it("Alice can access her own row", async () => {
      const id = await insertTodo(ALICE, "alice secret")
      const t = await table()
      const row = await repository.findById({
        identity: { userId: ALICE },
        table: t,
        id,
      })
      expect(row).not.toBeNull()
      expect(row?.title).toBe("alice secret")
    })

    it("Alice cannot read Bob's row", async () => {
      const id = await insertTodo(BOB, "bob secret")
      const t = await table()
      const row = await repository.findById({
        identity: { userId: ALICE },
        table: t,
        id,
      })
      expect(row).toBeNull()
    })

    it("Alice cannot update Bob's row", async () => {
      const id = await insertTodo(BOB, "bob secret")
      const t = await table()
      const row = await repository.updateById({
        identity: { userId: ALICE },
        table: t,
        id,
        values: { title: "hacked" },
      })
      expect(row).toBeNull()
    })

    it("Alice cannot delete Bob's row", async () => {
      const id = await insertTodo(BOB, "bob secret")
      const t = await table()
      const deleted = await repository.deleteById({
        identity: { userId: ALICE },
        table: t,
        id,
      })
      expect(deleted).toBe(false)
    })

    it("Bob cannot read Alice's row", async () => {
      const id = await insertTodo(ALICE, "alice secret")
      const t = await table()
      const row = await repository.findById({
        identity: { userId: BOB },
        table: t,
        id,
      })
      expect(row).toBeNull()
    })

    it("hidden row behaves identically to missing row", async () => {
      const bobId = await insertTodo(BOB, "bob secret")
      const missingId = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c33"
      const t = await table()

      const hiddenFind = await repository.findById({
        identity: { userId: ALICE },
        table: t,
        id: bobId,
      })
      const missingFind = await repository.findById({
        identity: { userId: ALICE },
        table: t,
        id: missingId,
      })
      expect(hiddenFind).toEqual(missingFind)

      const hiddenUpdate = await repository.updateById({
        identity: { userId: ALICE },
        table: t,
        id: bobId,
        values: { title: "x" },
      })
      const missingUpdate = await repository.updateById({
        identity: { userId: ALICE },
        table: t,
        id: missingId,
        values: { title: "x" },
      })
      expect(hiddenUpdate).toEqual(missingUpdate)

      const hiddenDelete = await repository.deleteById({
        identity: { userId: ALICE },
        table: t,
        id: bobId,
      })
      const missingDelete = await repository.deleteById({
        identity: { userId: ALICE },
        table: t,
        id: missingId,
      })
      expect(hiddenDelete).toEqual(missingDelete)
    })
  })

  describe("connection identity isolation", () => {
    beforeEach(async () => {
      await clearTodos()
    })

    it("identity disappears after commit", async () => {
      const runner = createTransactionRunner(() => pool.connect())
      await runner.withTransaction(
        async () => {
          // identity set
        },
        { userId: ALICE },
      )

      const leaked = await runner.withTransaction(async (ctx) => {
        const rs = await ctx.query<{ value: string | null }>(
          "SELECT nullif(current_setting('microjbase.user_id', true), '') AS value",
        )
        return rs.rows[0]?.value
      })
      expect(leaked).toBeNull()
    })

    it("identity disappears after rollback", async () => {
      const runner = createTransactionRunner(() => pool.connect())
      await expect(
        runner.withTransaction(
          async () => {
            throw new Error("deliberate")
          },
          { userId: ALICE },
        ),
      ).rejects.toThrow()

      const leaked = await runner.withTransaction(async (ctx) => {
        const rs = await ctx.query<{ value: string | null }>(
          "SELECT nullif(current_setting('microjbase.user_id', true), '') AS value",
        )
        return rs.rows[0]?.value
      })
      expect(leaked).toBeNull()
    })

    it("pooled connection reuse does not inherit prior identity", async () => {
      const singlePool = createPool({ databaseUrl, maxConnections: 1 })
      const runner = createTransactionRunner(() => singlePool.connect())

      await runner.withTransaction(
        async () => {
          // set identity
        },
        { userId: ALICE },
      )

      const leaked = await runner.withTransaction(async (ctx) => {
        const rs = await ctx.query<{ value: string | null }>(
          "SELECT nullif(current_setting('microjbase.user_id', true), '') AS value",
        )
        return rs.rows[0]?.value
      })
      expect(leaked).toBeNull()

      await singlePool.close()
    })

    it("parallel Alice/Bob requests do not cross-contaminate", async () => {
      const t = await table()

      const [aliceRows, bobRows] = await Promise.all([
        (async () => {
          await repository.create({
            identity: { userId: ALICE },
            table: t,
            values: { title: "alice parallel" },
          })
          const page = await repository.list({
            identity: { userId: ALICE },
            table: t,
            limit: 10,
            offset: 0,
          })
          return page.items
        })(),
        (async () => {
          await repository.create({
            identity: { userId: BOB },
            table: t,
            values: { title: "bob parallel" },
          })
          const page = await repository.list({
            identity: { userId: BOB },
            table: t,
            limit: 10,
            offset: 0,
          })
          return page.items
        })(),
      ])

      expect(
        aliceRows.some((r: Record<string, unknown>) => r.user_id === BOB),
      ).toBe(false)
      expect(
        bobRows.some((r: Record<string, unknown>) => r.user_id === ALICE),
      ).toBe(false)
      expect(
        aliceRows.some(
          (r: Record<string, unknown>) => r.title === "alice parallel",
        ),
      ).toBe(true)
      expect(
        bobRows.some(
          (r: Record<string, unknown>) => r.title === "bob parallel",
        ),
      ).toBe(true)
    })
  })

  describe("injection and security", () => {
    it("does not allow table identifier injection", async () => {
      await expect(
        withAdminClient(async (admin) => {
          await buildTableRegistry(
            {
              mappings: [
                {
                  alias: "bad",
                  schema: "public",
                  table: "todos; DROP TABLE public.todos",
                },
              ],
            },
            { query: (text, values) => admin.query(text, values) },
          )
        }),
      ).rejects.toThrow()
    })

    it("does not allow column injection", async () => {
      const t = await table()
      await expect(
        repository.create({
          identity: { userId: ALICE },
          table: t,
          values: { "title; DROP TABLE public.todos": "x" },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      })
    })

    it("never interpolates request values into SQL", async () => {
      const t = await table()
      const maliciousTitle = "'); DROP TABLE public.todos; --"
      const row = await repository.create({
        identity: { userId: ALICE },
        table: t,
        values: { title: maliciousTitle },
      })
      expect(row.title).toBe(maliciousTitle)

      await withAdminClient(async (admin) => {
        const rs = await admin.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'todos') AS exists`,
        )
        expect(rs.rows[0]?.exists).toBe(true)
      })
    })

    it("does not expose raw database errors", async () => {
      const t = await table()
      await expect(
        repository.create({
          identity: { userId: ALICE },
          table: t,
          values: { title: "x", user_id: "not-a-uuid" },
        }),
      ).rejects.toMatchObject({
        code: expect.not.stringMatching(/syntax|relation|constraint/i),
        message: expect.not.stringMatching(/todos|constraint|syntax/i),
      })
    })
  })
})
