// Unit tests for the V02-10 durable exposure registry module.
//
// The SQL boundary is exercised through in-memory fakes honouring the exact
// statement shapes the module issues. Real-PostgreSQL import and privilege
// behaviour lives in the integration suite.

import { describe, expect, it } from "vitest"
import type pg from "pg"

import {
  buildImportPayload,
  findExposureByAlias,
  findExposureByTarget,
  importInitialExposure,
  readExposureRegistryState,
} from "../../../src/database/index.js"

interface FakeRegistry {
  initialized: boolean
  importedAt: Date | null
  rows: { alias: string; schema: string; table: string; exposed: boolean }[]
  failNextImport: boolean
  /** When the import fails, simulate a concurrent winner initializing. */
  winOnFailure: boolean
  /**
   * What the simulated winner imported; defaults to the caller's own
   * payload (an identical concurrent import). A different array models a
   * conflicting winner.
   */
  winnerRows?: { alias: string; schema: string; table: string }[]
}

function createFake(fake: FakeRegistry) {
  const calls: { text: string; values: unknown[] }[] = []
  async function query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<pg.QueryResult> {
    calls.push({ text, values: [...values] })
    const empty = { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }
    if (text.includes("import_exposure_registry")) {
      if (fake.failNextImport) {
        fake.failNextImport = false
        if (fake.winOnFailure) {
          const payload = JSON.parse(values[0] as string) as {
            alias: string
            schema: string
            table: string
          }[]
          const winnerRows = fake.winnerRows ?? payload
          fake.rows.push(...winnerRows.map((m) => ({ ...m, exposed: true })))
          fake.initialized = true
          fake.importedAt = new Date()
        }
        const error = new Error("exposure registry is already initialized")
        ;(error as { code?: string }).code = "P0001"
        throw error
      }
      const payload = JSON.parse(values[0] as string) as {
        alias: string
        schema: string
        table: string
      }[]
      fake.rows.push(...payload.map((m) => ({ ...m, exposed: true })))
      fake.initialized = true
      fake.importedAt = new Date()
      return empty
    }
    if (text.includes("SELECT initialized, imported_at")) {
      return {
        rows: [{ initialized: fake.initialized, imported_at: fake.importedAt }],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      }
    }
    if (text.includes("WHERE schema_name = $1 AND table_name = $2")) {
      const row = fake.rows.find(
        (r) => r.schema === values[0] && r.table === values[1],
      )
      return {
        rows: row
          ? [
              {
                alias: row.alias,
                schema_name: row.schema,
                table_name: row.table,
                exposed: row.exposed,
              },
            ]
          : [],
        rowCount: row ? 1 : 0,
        command: "",
        oid: 0,
        fields: [],
      }
    }
    if (text.includes("WHERE alias = $1")) {
      const row = fake.rows.find((r) => r.alias === values[0])
      return {
        rows: row
          ? [
              {
                alias: row.alias,
                schema_name: row.schema,
                table_name: row.table,
                exposed: row.exposed,
              },
            ]
          : [],
        rowCount: row ? 1 : 0,
        command: "",
        oid: 0,
        fields: [],
      }
    }
    if (text.includes("WHERE exposed")) {
      return {
        rows: fake.rows
          .filter((r) => r.exposed)
          .map((r) => ({
            alias: r.alias,
            schema_name: r.schema,
            table_name: r.table,
          })),
        rowCount: 0,
        command: "",
        oid: 0,
        fields: [],
      }
    }
    throw new Error(`unexpected statement: ${text}`)
  }
  return { query, calls }
}

function mapping(alias: string, schema: string, table: string) {
  return { alias, schema, table }
}

describe("buildImportPayload", () => {
  it("accepts valid mappings", () => {
    expect(buildImportPayload([mapping("todos", "public", "todos")])).toEqual([
      { alias: "todos", schema: "public", table: "todos" },
    ])
  })

  it("accepts an empty mapping list", () => {
    expect(buildImportPayload([])).toEqual([])
  })

  it("rejects aliases outside the alias pattern", () => {
    expect(() =>
      buildImportPayload([mapping("Bad", "public", "todos")]),
    ).toThrow(/alias/)
    expect(() =>
      buildImportPayload([mapping("has space", "public", "todos")]),
    ).toThrow(/alias/)
  })

  it("rejects identifiers outside the identifier pattern", () => {
    expect(() =>
      buildImportPayload([mapping("t", 'weird"name', "todos")]),
    ).toThrow(/not a valid identifier/)
    expect(() =>
      buildImportPayload([mapping("t", "public", "t;drop")]),
    ).toThrow(/not a valid identifier/)
  })

  it("rejects internal schemas case-insensitively", () => {
    for (const schema of [
      "microjbase",
      "MICROJBASE",
      "pg_catalog",
      "information_schema",
    ]) {
      expect(() => buildImportPayload([mapping("t", schema, "todos")])).toThrow(
        /cannot be exposed/,
      )
    }
  })

  it("rejects duplicate aliases and duplicate targets", () => {
    expect(() =>
      buildImportPayload([
        mapping("t", "public", "a"),
        mapping("t", "public", "b"),
      ]),
    ).toThrow(/duplicate/)
    expect(() =>
      buildImportPayload([
        mapping("a", "public", "t"),
        mapping("b", "public", "t"),
      ]),
    ).toThrow(/duplicate/)
  })
})

describe("readExposureRegistryState", () => {
  it("maps state and exposed rows", async () => {
    const fake: FakeRegistry = {
      initialized: true,
      importedAt: new Date("2026-09-25T00:00:00Z"),
      rows: [
        { alias: "a", schema: "public", table: "a", exposed: true },
        { alias: "b", schema: "public", table: "b", exposed: false },
      ],
      failNextImport: false,
      winOnFailure: false,
    }
    const { query } = createFake(fake)
    const state = await readExposureRegistryState({ query })
    expect(state.initialized).toBe(true)
    expect(state.importedAt).toEqual(new Date("2026-09-25T00:00:00Z"))
    expect(state.exposed).toEqual([
      { alias: "a", schema: "public", table: "a" },
    ])
  })

  it("reports an uninitialized registry", async () => {
    const fake: FakeRegistry = {
      initialized: false,
      importedAt: null,
      rows: [],
      failNextImport: false,
      winOnFailure: false,
    }
    const { query } = createFake(fake)
    const state = await readExposureRegistryState({ query })
    expect(state.initialized).toBe(false)
    expect(state.exposed).toEqual([])
  })

  it("fails closed on a missing singleton row", async () => {
    const { query } = createFake({
      initialized: false,
      importedAt: null,
      rows: [],
      failNextImport: false,
      winOnFailure: false,
    })
    const broken = async (): Promise<pg.QueryResult> => ({
      rows: [],
      rowCount: 0,
      command: "",
      oid: 0,
      fields: [],
    })
    await expect(readExposureRegistryState({ query: broken })).rejects.toThrow(
      /Malformed exposure registry state/,
    )
    await expect(query("SELECT 1")).rejects.toThrow(/unexpected statement/)
  })
})

describe("importInitialExposure", () => {
  it("imports mappings and returns the refreshed state", async () => {
    const fake: FakeRegistry = {
      initialized: false,
      importedAt: null,
      rows: [],
      failNextImport: false,
      winOnFailure: false,
    }
    const { query, calls } = createFake(fake)
    const state = await importInitialExposure({ query }, [
      mapping("todos", "public", "todos"),
    ])
    expect(state.initialized).toBe(true)
    expect(state.exposed).toEqual([
      { alias: "todos", schema: "public", table: "todos" },
    ])
    const importCall = calls.find((c) =>
      c.text.includes("import_exposure_registry"),
    )
    expect(importCall?.values[0]).toBe(
      '[{"alias":"todos","schema":"public","table":"todos"}]',
    )
  })

  it("conflicts when the registry is already initialized", async () => {
    const fake: FakeRegistry = {
      initialized: true,
      importedAt: new Date("2026-09-25T00:00:00Z"),
      rows: [{ alias: "x", schema: "public", table: "x", exposed: true }],
      failNextImport: false,
      winOnFailure: false,
    }
    const { query } = createFake(fake)
    await expect(
      importInitialExposure({ query }, [mapping("t", "public", "t")]),
    ).rejects.toThrow(/already initialized/)
    // No import statement was attempted.
    expect(fake.rows).toHaveLength(1)
  })

  it("returns the winner state when another process initialized first with the same set", async () => {
    const fake: FakeRegistry = {
      initialized: false,
      importedAt: null,
      rows: [],
      failNextImport: true,
      winOnFailure: true,
    }
    const { query } = createFake(fake)
    const state = await importInitialExposure({ query }, [
      mapping("todos", "public", "todos"),
    ])
    expect(state.initialized).toBe(true)
    expect(state.exposed).toEqual([
      { alias: "todos", schema: "public", table: "todos" },
    ])
  })

  it("conflicts when the concurrent winner initialized a different set", async () => {
    const fake: FakeRegistry = {
      initialized: false,
      importedAt: null,
      rows: [],
      failNextImport: true,
      winOnFailure: true,
      winnerRows: [{ alias: "stolen", schema: "app", table: "secrets" }],
    }
    const { query } = createFake(fake)
    await expect(
      importInitialExposure({ query }, [mapping("todos", "public", "todos")]),
    ).rejects.toThrow(/initialized concurrently with a different mapping set/)
  })

  it("conflicts when the winner's set only differs by an extra mapping", async () => {
    const fake: FakeRegistry = {
      initialized: false,
      importedAt: null,
      rows: [],
      failNextImport: true,
      winOnFailure: true,
      winnerRows: [
        { alias: "todos", schema: "public", table: "todos" },
        { alias: "extra", schema: "public", table: "extra" },
      ],
    }
    const { query } = createFake(fake)
    await expect(
      importInitialExposure({ query }, [mapping("todos", "public", "todos")]),
    ).rejects.toThrow(/different mapping set/)
  })

  it("propagates a translated error when the import genuinely failed", async () => {
    const fake: FakeRegistry = {
      initialized: false,
      importedAt: null,
      rows: [],
      failNextImport: true,
      winOnFailure: false,
    }
    const { query } = createFake(fake)
    await expect(
      importInitialExposure({ query }, [mapping("t", "public", "t")]),
    ).rejects.toThrow(/unexpected database error/)
  })
})

describe("exposure lookups", () => {
  it("finds rows by target and alias including unexposed history", async () => {
    const fake: FakeRegistry = {
      initialized: true,
      importedAt: null,
      rows: [
        { alias: "a", schema: "public", table: "a", exposed: false },
        { alias: "b", schema: "public", table: "b", exposed: true },
      ],
      failNextImport: false,
      winOnFailure: false,
    }
    const { query } = createFake(fake)
    await expect(
      findExposureByTarget({ query }, "public", "a"),
    ).resolves.toEqual({
      alias: "a",
      schema: "public",
      table: "a",
      exposed: false,
    })
    await expect(findExposureByAlias({ query }, "b")).resolves.toEqual({
      alias: "b",
      schema: "public",
      table: "b",
      exposed: true,
    })
    await expect(findExposureByAlias({ query }, "missing")).resolves.toBeNull()
    await expect(
      findExposureByTarget({ query }, "public", "missing"),
    ).resolves.toBeNull()
  })
})
