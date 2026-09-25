// Unit coverage for the pure management UI modules: token-store, format, and
// view-models. The client ships as dependency-free browser JavaScript, so the
// imports are untyped at this boundary — vitest executes the real modules.

import { afterEach, describe, expect, it } from "vitest"

// @ts-expect-error plain-JS browser module, untyped import boundary
import * as tokenStore from "../../../../admin-ui/token-store.js"
// @ts-expect-error plain-JS browser module, untyped import boundary
import * as format from "../../../../admin-ui/format.js"
// @ts-expect-error plain-JS browser module, untyped import boundary
import * as viewModels from "../../../../admin-ui/view-models.js"

import { fixtureHistoryEnvelope, fixtureSnapshot } from "./fixtures.js"

describe("token-store (memory-only operator token)", () => {
  afterEach(() => {
    tokenStore.clearToken()
  })

  it("starts empty, remembers one token, and clears on sign-out", () => {
    expect(tokenStore.getToken()).toBeNull()
    tokenStore.setToken("op-token")
    expect(tokenStore.getToken()).toBe("op-token")
    tokenStore.clearToken()
    expect(tokenStore.getToken()).toBeNull()
  })

  it("never touches browser storage surfaces", async () => {
    const guard = (name: string) => ({
      configurable: true,
      get() {
        throw new Error(`${name} must not be accessed`)
      },
    })
    const originals = ["localStorage", "sessionStorage", "cookieStore"] as const
    const descriptors: [string, PropertyDescriptor | undefined][] =
      originals.map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ])
    for (const name of originals) {
      Object.defineProperty(globalThis, name, guard(name))
    }
    try {
      // Drive the store plus every pure module a page render depends on.
      tokenStore.setToken("op-token")
      expect(tokenStore.getToken()).toBe("op-token")
      tokenStore.clearToken()
      format.escapeHtml("<x>")
      viewModels.summarizeSnapshot(fixtureSnapshot)
      viewModels.historyViewModel(fixtureHistoryEnvelope)
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, name)
        } else {
          Object.defineProperty(globalThis, name, descriptor)
        }
      }
    }
  })
})

describe("format", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(format.escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
    )
  })

  it("leaves ordinary text untouched and stringifies non-strings", () => {
    expect(format.escapeHtml("plain text")).toBe("plain text")
    expect(format.escapeHtml(42)).toBe("42")
  })

  it("humanizes frozen enum values and passes unknown values through", () => {
    expect(format.humanize("primary_key")).toBe("Primary key")
    expect(format.humanize("set_null")).toBe("SET NULL")
    expect(format.humanize("custom_thing")).toBe("custom_thing")
  })

  it("renders timestamps as deterministic UTC text", () => {
    expect(format.formatUtcDateTime("2026-09-25T12:00:00.000Z")).toBe(
      "2026-09-25 12:00:00 UTC",
    )
    expect(format.formatUtcDateTime("not-a-date")).toBe("not-a-date")
  })

  it("marks expression positions and handles empty column lists", () => {
    expect(format.formatColumnList(["a", null, "b"])).toBe("a, expression, b")
    expect(format.formatColumnList([])).toBe("—")
  })
})

describe("view-models", () => {
  it("summarizes schemas, tables, and migrations from the snapshot", () => {
    const summary = viewModels.summarizeSnapshot(fixtureSnapshot)
    expect(summary.schemas.map((s: { name: string }) => s.name)).toEqual([
      "app",
      "microjbase",
      "empty_schema",
    ])
    const app = summary.schemas[0]
    expect(app.tables).toHaveLength(1)
    expect(app.tables[0]).toMatchObject({
      schema: "app",
      name: "todos",
      classification: "operator",
      exposed: true,
      alias: "todos",
      rlsEnabled: true,
      rlsForced: true,
      columnCount: 2,
    })
    expect(summary.migrations).toEqual([
      {
        filename: "0001_init.sql",
        checksum: "abc123",
        appliedAt: "2026-09-25T12:00:00.000Z",
      },
    ])
  })

  it("classifies only a schema-less snapshot as the empty overview", () => {
    expect(viewModels.isEmptySnapshot({ schemas: [], migrations: [] })).toBe(
      true,
    )
    expect(
      viewModels.isEmptySnapshot({
        schemas: [
          { name: "s", owner: "o", classification: "operator", tables: [] },
        ],
        migrations: [],
      }),
    ).toBe(false)
    expect(
      viewModels.isEmptySnapshot(viewModels.summarizeSnapshot(fixtureSnapshot)),
    ).toBe(false)
  })

  it("builds a full table detail model with constraints and indexes", () => {
    const table = fixtureSnapshot.schemas[0]!.tables[0]!
    const model = viewModels.tableDetailModel(table)
    expect(model.fullName).toBe("app.todos")
    expect(model.exposed).toBe(true)
    expect(model.alias).toBe("todos")
    expect(model.rlsEnabled).toBe(true)
    expect(model.columns).toHaveLength(2)
    expect(model.columns[0]).toMatchObject({
      name: "id",
      renderedType: "uuid",
      nullable: false,
      defaultExpression: null,
    })
    expect(model.constraints[1]).toMatchObject({
      classification: "foreign_key",
      references: { schema: "app", table: "users", columns: ["id"] },
      onUpdate: "no_action",
      onDelete: "cascade",
    })
    expect(model.indexes[1].columns).toEqual([null])
  })

  it("summarizes one table for the overview rows", () => {
    const table = fixtureSnapshot.schemas[1]!.tables[0]!
    expect(viewModels.summarizeTable(table)).toMatchObject({
      schema: "microjbase",
      name: "sessions",
      classification: "internal",
      exposed: false,
      rlsEnabled: false,
      columnCount: 0,
    })
  })

  it("maps the history envelope with pagination windows", () => {
    const view = viewModels.historyViewModel(fixtureHistoryEnvelope)
    expect(view.rows).toHaveLength(2)
    expect(view.rows[0]).toMatchObject({
      id: 7,
      idempotencyKey: "2026-09-25-create-todos",
      commandType: "schema.table.create",
      status: "succeeded",
      errorCode: null,
      finishedAt: "2026-09-25T12:00:00.100Z",
    })
    expect(view.rows[1].errorCode).toBe("CONFLICT")
    expect(view.hasPrevious).toBe(false)
    expect(view.hasNext).toBe(false)

    const nextPage = viewModels.historyViewModel({
      ...fixtureHistoryEnvelope,
      meta: { limit: 2, offset: 2 },
    })
    expect(nextPage.hasPrevious).toBe(true)
    expect(nextPage.hasNext).toBe(true)

    const fullPage = viewModels.historyViewModel({
      data: fixtureHistoryEnvelope.data,
      meta: { limit: 2, offset: 0 },
    })
    expect(fullPage.hasNext).toBe(true)
  })

  it("throws on malformed envelopes instead of inventing data", () => {
    expect(() => viewModels.summarizeSnapshot(null)).toThrow()
    expect(() => viewModels.summarizeSnapshot({ schemas: "nope" })).toThrow()
    expect(() => viewModels.tableDetailModel({})).toThrow()
    expect(() => viewModels.historyViewModel({ data: [] })).toThrow()
  })
})
