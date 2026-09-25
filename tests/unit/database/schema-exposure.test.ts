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
  type OwnershipComparisonProbe,
  ownershipPolicyName,
  ownershipPolicyTemplateShape,
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

// PostgreSQL's deparsed rendering of the frozen ownership comparison the
// module compiles into its policies (verified on PostgreSQL 18.6).
function ownershipExpr(column: string): string {
  return `(${column} = (NULLIF(current_setting('microjbase.user_id'::text, true), ''::text))::uuid)`
}

interface FakePolicyRow {
  policy_name: string
  command: string
  permissive: boolean
  using_expression: string | null
  check_expression: string | null
}

// The four module-owned ownership policies the verification requires, bound
// to the "id" ownership column of the fake table.
function moduleOwnershipPolicies(table: string): FakePolicyRow[] {
  const expr = ownershipExpr("id")
  return [
    {
      policy_name: ownershipPolicyName(table, "id", "read"),
      command: "r",
      permissive: true,
      using_expression: expr,
      check_expression: null,
    },
    {
      policy_name: ownershipPolicyName(table, "id", "insert"),
      command: "a",
      permissive: true,
      using_expression: null,
      check_expression: expr,
    },
    {
      policy_name: ownershipPolicyName(table, "id", "update"),
      command: "w",
      permissive: true,
      using_expression: expr,
      check_expression: expr,
    },
    {
      policy_name: ownershipPolicyName(table, "id", "delete"),
      command: "d",
      permissive: true,
      using_expression: expr,
      check_expression: null,
    },
  ]
}

// The probe stands in for the service's rolled-back probe policy: it returns
// the same rendering the fake policy rows above carry for the frozen
// comparison, so a module-named policy row verifies and anything else fails.
const fakeProbe: OwnershipComparisonProbe = {
  async render(_schema, _table, column, template) {
    const shape = ownershipPolicyTemplateShape(template)
    return {
      using: shape.using ? ownershipExpr(column) : null,
      withCheck: shape.withCheck ? ownershipExpr(column) : null,
    }
  },
}

function probeFake(extraPolicies: FakePolicyRow[] = []) {
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
        rows: [...moduleOwnershipPolicies("items"), ...extraPolicies],
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
    await verifyExposureCandidate(
      query,
      "microjbase_runtime",
      "app",
      "items",
      fakeProbe,
    )
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
      fakeProbe,
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

  it("rejects a broader permissive policy beside the ownership policy", async () => {
    // A permissive USING (true) policy applicable to the runtime role ORs
    // with the ownership policy and would expose one tenant's rows to
    // another, so verification fails closed (JDW-27).
    const broad: FakePolicyRow = {
      policy_name: "operator_broad_select",
      command: "r",
      permissive: true,
      using_expression: "true",
      check_expression: null,
    }
    const { query } = probeFake([broad])
    await expect(
      verifyExposureCandidate(
        query,
        "microjbase_runtime",
        "app",
        "items",
        fakeProbe,
      ),
    ).rejects.toThrow(/other than the managed read ownership policy/)
  })

  it("requires the managed ownership policy for every exercised command", async () => {
    // Without the module-owned delete ownership policy, the strict check
    // fails closed even though a permissive policy still applies.
    const rows = moduleOwnershipPolicies("items").filter(
      (row) => row.command !== "d",
    )
    const recorded: RecordedQuery[] = []
    const query = (async <R extends pg.QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<pg.QueryResult<R>> => {
      recorded.push({ text, values: [...values] })
      const result = { rowCount: 0, command: "", oid: 0, fields: [] }
      if (text.includes("AS exists")) {
        return { ...result, rows: [{ exists: true }] } as never
      }
      if (text.includes("relforcerowsecurity")) {
        return {
          ...result,
          rows: [{ relrowsecurity: true, relforcerowsecurity: true }],
        } as never
      }
      if (text.includes("pol.polroles")) {
        return { ...result, rows: rows } as never
      }
      if (text.includes("i.indisprimary")) {
        return {
          ...result,
          rows: [{ column_name: "id", data_type: "uuid" }],
        } as never
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
          ],
        } as never
      }
      throw new Error(`unexpected statement: ${text}`)
    }) as unknown as Parameters<typeof verifyExposureCandidate>[0]
    await expect(
      verifyExposureCandidate(
        query,
        "microjbase_runtime",
        "app",
        "items",
        fakeProbe,
      ),
    ).rejects.toThrow(/no managed delete ownership policy/)
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
