// Unit tests for the V02-13 swappable table registry holder and the
// exposure verification probes (qualified-catalogue shape and the
// least-privilege column contract).

import { describe, expect, it } from "vitest"
import type pg from "pg"

import type {
  ExposedTable,
  TableRegistry,
} from "../../../src/contracts/index.js"
import {
  checkExposureRegistryWriteAccess,
  createSwappableTableRegistry,
  verifyExposureCandidate,
} from "../../../src/database/index.js"

function table(alias: string): ExposedTable {
  return {
    alias,
    schema: "public",
    table: alias,
    primaryKey: "id",
    readableColumns: ["id"],
    insertableColumns: ["id"],
    updatableColumns: ["id"],
  }
}

function registryOf(aliases: string[]): TableRegistry {
  const tables = new Map(aliases.map((alias) => [alias, table(alias)]))
  return {
    get: (alias) => tables.get(alias) ?? null,
    list: () => [...tables.values()],
  }
}

describe("createSwappableTableRegistry", () => {
  it("delegates get/list to the current registry", () => {
    const holder = createSwappableTableRegistry(registryOf(["a", "b"]))
    expect(holder.get("a")?.table).toBe("a")
    expect(holder.get("missing")).toBeNull()
    expect(holder.list().map((entry) => entry.alias)).toEqual(["a", "b"])
  })

  it("serves the new snapshot after an atomic replace", () => {
    const holder = createSwappableTableRegistry(registryOf(["a"]))
    holder.replace(registryOf(["c"]))
    expect(holder.get("a")).toBeNull()
    expect(holder.get("c")?.table).toBe("c")
    expect(holder.list().map((entry) => entry.alias)).toEqual(["c"])
  })

  it("supports unexpose-then-expose sequences across swaps", () => {
    const holder = createSwappableTableRegistry(registryOf(["a"]))
    holder.replace(registryOf([]))
    expect(holder.list()).toEqual([])
    holder.replace(registryOf(["a", "b"]))
    expect(holder.list()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Exposure verification probes. The statements are pinned here so a hostile
// first search_path entry can never shadow the catalogue again: every
// catalogue reference and privilege function must be pg_catalog-qualified
// (R5 review, JDW-23), and the insert/update contract must exclude columns
// whose types the data contract cannot represent.
// ---------------------------------------------------------------------------

interface RecordedQuery {
  text: string
  values: readonly unknown[]
}

function probeFake() {
  const recorded: RecordedQuery[] = []
  const query = async <R extends pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<pg.QueryResult<R>> => {
    recorded.push({ text, values: [...values] })
    const result = { rowCount: 0, command: "", oid: 0, fields: [] }
    if (text.includes("AS exists")) {
      return {
        ...result,
        rows: [{ exists: true }],
      } as unknown as pg.QueryResult<R>
    }
    if (text.includes("relforcerowsecurity")) {
      return {
        ...result,
        rows: [{ relrowsecurity: true, relforcerowsecurity: true }],
      } as unknown as pg.QueryResult<R>
    }
    if (text.includes("pol.polroles")) {
      return {
        ...result,
        rows: [{ applicable: true }],
      } as unknown as pg.QueryResult<R>
    }
    if (text.includes("i.indisprimary")) {
      return {
        ...result,
        rows: [{ column_name: "id", data_type: "uuid" }],
      } as unknown as pg.QueryResult<R>
    }
    if (text.includes("a.attidentity")) {
      return {
        ...result,
        rows: [
          {
            column_name: "id",
            data_type: "uuid",
            attgenerated: "",
            attidentity: "",
          },
          {
            column_name: "title",
            data_type: "text",
            attgenerated: "",
            attidentity: "",
          },
          {
            column_name: "payload",
            data_type: "bytea",
            attgenerated: "",
            attidentity: "",
          },
          {
            column_name: "derived",
            data_type: "text",
            attgenerated: "s",
            attidentity: "",
          },
          {
            column_name: "serial_no",
            data_type: "integer",
            attgenerated: "",
            attidentity: "a",
          },
        ],
      } as unknown as pg.QueryResult<R>
    }
    throw new Error(`unexpected statement: ${text}`)
  }
  return { query, recorded }
}

const UNQUALIFIED_CATALOG_REF =
  /(?<!pg_catalog\.)\b(?:pg_class|pg_namespace|pg_policy|pg_index|pg_attribute|format_type|has_table_privilege|has_sequence_privilege|pg_has_role)\b/

describe("verifyExposureCandidate", () => {
  it("schema-qualifies every catalogue reference in the probes", async () => {
    const { query, recorded } = probeFake()
    await verifyExposureCandidate(query, "microjbase_runtime", "app", "items")
    expect(recorded).toHaveLength(5)
    for (const call of recorded) {
      expect(call.text).not.toMatch(UNQUALIFIED_CATALOG_REF)
    }
  })

  it("excludes unsupported types from the insert/update grant contract", async () => {
    const { query } = probeFake()
    const verification = await verifyExposureCandidate(
      query,
      "microjbase_runtime",
      "app",
      "items",
    )
    // bytea is not a supported data-contract type, so it receives no grant
    // at all; generated/identity columns stay readable but not writable.
    expect(verification.readableColumns).toEqual([
      "id",
      "title",
      "derived",
      "serial_no",
    ])
    expect(verification.insertableColumns).toEqual(["id", "title"])
    expect(verification.updatableColumns).toEqual(["title"])
  })
})

describe("checkExposureRegistryWriteAccess", () => {
  it("probes with pg_catalog-qualified privilege functions", async () => {
    const recorded: string[] = []
    const client = {
      async query<R extends pg.QueryResultRow>(
        text: string,
      ): Promise<pg.QueryResult<R>> {
        recorded.push(text)
        return {
          rows: [{ has: true }],
          rowCount: 1,
          command: "",
          oid: 0,
          fields: [],
        } as unknown as pg.QueryResult<R>
      },
    }
    await checkExposureRegistryWriteAccess(
      client as unknown as import("pg").Client,
    )
    expect(recorded.length).toBeGreaterThan(0)
    for (const text of recorded) {
      expect(text).toContain("pg_catalog.has_")
      expect(text).not.toMatch(UNQUALIFIED_CATALOG_REF)
    }
  })

  it("fails closed when a required privilege is missing", async () => {
    const client = {
      async query<R extends pg.QueryResultRow>(): Promise<pg.QueryResult<R>> {
        return {
          rows: [{ has: false }],
          rowCount: 1,
          command: "",
          oid: 0,
          fields: [],
        } as unknown as pg.QueryResult<R>
      },
    }
    await expect(
      checkExposureRegistryWriteAccess(
        client as unknown as import("pg").Client,
      ),
    ).rejects.toThrow(/missing required privilege/)
  })
})
