// R6 (JDW-28) locked-guard unit tests: the fail-closed boundary for RLS
// disable and exposure is the catalogue/registry re-read inside the
// advisory-locked transaction, not the process-local preflight. These tests
// pin the compiled statement order and the safe error envelopes without a
// database.

import { describe, expect, it } from "vitest"

import type {
  SchemaCatalogue,
  SchemaCatalogueColumn,
  SchemaCatalogueSchema,
  SchemaCatalogueTable,
  TypeIdentity,
} from "../../../src/contracts/index.js"
import {
  compileAssertExposurePrerequisites,
  compileDisableRowSecurity,
  createSchemaExposureService,
  ownershipPolicyName,
  ownershipPolicyTemplateShape,
  translateDdlError,
  type ExecuteOutcome,
  type SchemaDdlExecutor,
} from "../../../src/database/index.js"
import type { Pool } from "../../../src/database/index.js"

const APP_SCHEMA = "app"
const ADMIN_ROLE = "mjb_admin"
const RUNTIME_ROLE = "mjb_runtime"

// PostgreSQL's deparsed rendering of the frozen ownership comparison (the
// shape verifyExposureCandidate compares against, verified on PG 18.6).
function ownershipDeparse(column: string): string {
  return `(${column} = (NULLIF(current_setting('microjbase.user_id'::text, true), ''::text))::uuid)`
}

describe("compileDisableRowSecurity locked guard (R6, JDW-28)", () => {
  it("emits the durable-registry exposure guard as the first statement", () => {
    const plan = compileDisableRowSecurity({ schema: "app", table: "items" })
    expect(plan.statements).toHaveLength(3)
    const [guard, noForce, disable] = plan.statements
    expect(guard).toContain("DO $microjbase$")
    expect(guard).toContain("FROM microjbase.exposure_registry")
    expect(guard).toContain("exposed = TRUE")
    expect(guard).toContain("9C003")
    // Identifiers are embedded through the audited literal helper.
    expect(guard).toContain("schema_name = 'app'")
    expect(guard).toContain("table_name = 'items'")
    expect(noForce).toBe(
      'ALTER TABLE "app"."items" NO FORCE ROW LEVEL SECURITY',
    )
    expect(disable).toBe('ALTER TABLE "app"."items" DISABLE ROW LEVEL SECURITY')
    expect(plan.statements.indexOf(guard ?? "")).toBe(0)
  })

  it("still refuses internal schemas before any SQL exists", () => {
    expect(() =>
      compileDisableRowSecurity({ schema: "pg_toast", table: "items" }),
    ).toThrow("Internal schemas cannot be modified")
  })
})

describe("compileAssertExposurePrerequisites (R6, JDW-28)", () => {
  it("re-reads both RLS bits under the lock and raises 9C004", () => {
    const plan = compileAssertExposurePrerequisites({
      schema: "app",
      table: "items",
      role: RUNTIME_ROLE,
    })
    expect(plan.statements).toHaveLength(1)
    const guard = plan.statements[0] ?? ""
    expect(guard).toContain("pg_catalog.pg_class")
    expect(guard).toContain("relrowsecurity")
    expect(guard).toContain("relforcerowsecurity")
    expect(guard).toContain("relkind = 'r'")
    expect(guard).toContain("9C004")
    expect(guard).toContain("n.nspname = 'app'")
    expect(guard).toContain("c.relname = 'items'")
  })
})

describe("translateDdlError R6 mappings (JDW-28)", () => {
  it("maps 9C003 to the exposed-table CONFLICT message", () => {
    const mapped = translateDdlError({
      code: "9C003",
      message: 'table "secret_name" is exposed',
    })
    expect(mapped).toMatchObject({ code: "CONFLICT", status: 409 })
    expect(mapped.message).toBe(
      "Table is exposed to the data API and cannot be modified",
    )
    expect(mapped.message).not.toContain("secret_name")
  })

  it("maps 9C004 to a fixed CONFLICT envelope without database text", () => {
    const mapped = translateDdlError({
      code: "9C004",
      message: "row security is not enabled and forced on the table",
    })
    expect(mapped).toMatchObject({ code: "CONFLICT", status: 409 })
    expect(mapped.message.length).toBeGreaterThan(0)
    expect(mapped.message).not.toContain("row security is not enabled")
  })

  it("maps 42710 to CONFLICT and 42704 to TABLE_NOT_FOUND, fixed messages", () => {
    const duplicate = translateDdlError({
      code: "42710",
      message: 'policy "mjb_items_owner_read_x" already exists',
    })
    expect(duplicate).toMatchObject({ code: "CONFLICT", status: 409 })
    expect(duplicate.message).toBe("Object already exists")
    expect(duplicate.message).not.toContain("mjb_items_owner_read_x")

    const missing = translateDdlError({
      code: "42704",
      message: 'policy "mjb_items_owner_read_x" does not exist',
    })
    expect(missing).toMatchObject({ code: "TABLE_NOT_FOUND", status: 404 })
    expect(missing.message).toBe("Referenced object does not exist")
    expect(missing.message).not.toContain("mjb_items_owner_read_x")
  })
})

// ---------------------------------------------------------------------------
// Service-level expose ordering: the locked prerequisite guard must precede
// every GRANT in the plan handed to the executor.
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly plan: unknown
  readonly options: { readonly idempotencyKey: string }
}

function fakeExecutor() {
  const calls: CapturedCall[] = []
  const outcome: ExecuteOutcome = {
    dryRun: false,
    replayed: false,
    record: null,
  }
  const executor: SchemaDdlExecutor = {
    async execute(plan, options) {
      calls.push({ plan, options })
      return outcome
    },
  }
  return { calls, executor }
}

function typeIdentity(name: string): TypeIdentity {
  return { schema: "pg_catalog", name, kind: "base" }
}

function column(
  name: string,
  renderedType: string,
  isNullable = true,
): SchemaCatalogueColumn {
  return {
    ordinal: 1,
    name,
    isNullable,
    defaultExpression: null,
    generated: "none",
    identity: "none",
    renderedType,
    type: typeIdentity(renderedType),
    baseType: null,
  }
}

function itemsCatalogue(): SchemaCatalogue {
  const table: SchemaCatalogueTable = {
    schema: APP_SCHEMA,
    name: "items",
    owner: ADMIN_ROLE,
    kind: "regular",
    hasRowSecurity: true,
    hasForcedRowSecurity: true,
    columns: [
      column("id", "uuid", false),
      column("owner", "uuid", false),
      column("title", "text", false),
    ],
    constraints: [
      {
        name: "items_pkey",
        classification: "primary_key",
        columns: ["id"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
    ],
    indexes: [],
  }
  const schema: SchemaCatalogueSchema = {
    name: APP_SCHEMA,
    owner: ADMIN_ROLE,
    tables: [table],
  }
  return { schemas: [schema] }
}

// The four module-owned ownership policies the strict verification requires.
// Expressions are no longer deparsed by the preflight query: the pinned
// probe deparse answers them per policy name below.
function modulePolicyRows() {
  return [
    {
      policy_name: ownershipPolicyName("items", "owner", "read"),
      command: "r",
      permissive: true,
    },
    {
      policy_name: ownershipPolicyName("items", "owner", "insert"),
      command: "a",
      permissive: true,
    },
    {
      policy_name: ownershipPolicyName("items", "owner", "update"),
      command: "w",
      permissive: true,
    },
    {
      policy_name: ownershipPolicyName("items", "owner", "delete"),
      command: "d",
      permissive: true,
    },
  ]
}

function fakeExposurePool(): Pool {
  // The ownership-comparison probe creates a rollback-only policy through a
  // dedicated client and reads back pg_get_expr's rendering, so the fake
  // tracks the latest CREATE POLICY shape to render the matching clause.
  let probeShape: { using: boolean; withCheck: boolean } | null = null
  const dispatch = async (text: string, values?: readonly unknown[]) => {
    const empty = { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }
    if (text === "BEGIN" || text === "ROLLBACK") {
      return { ...empty } as never
    }
    if (text.includes("set_config")) {
      // The pinned probe session hardening; the fake applies no resolution.
      return { ...empty } as never
    }
    if (text.startsWith("CREATE POLICY")) {
      probeShape = {
        using: text.includes(" USING "),
        withCheck: text.includes(" WITH CHECK "),
      }
      return { ...empty } as never
    }
    if (text.includes("FROM microjbase.schema_operations")) {
      return { ...empty, rows: [] } as never
    }
    if (text.includes("FROM microjbase.exposure_registry")) {
      // Both the by-target and by-alias preflight probes: nothing recorded.
      return { ...empty, rows: [] } as never
    }
    if (text.includes("AS exists")) {
      return { ...empty, rows: [{ exists: true }] } as never
    }
    if (text.includes("relforcerowsecurity")) {
      return {
        ...empty,
        rows: [{ relrowsecurity: true, relforcerowsecurity: true }],
      } as never
    }
    if (text.includes("i.indisprimary")) {
      return {
        ...empty,
        rows: [{ column_name: "id", data_type: "uuid" }],
      } as never
    }
    if (text.includes("a.attidentity")) {
      return {
        ...empty,
        rows: [
          {
            column_name: "id",
            data_type: "uuid",
            attgenerated: "",
            attidentity: "",
          },
          {
            column_name: "owner",
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
    if (text.includes("pol.polroles")) {
      return { ...empty, rows: modulePolicyRows() } as never
    }
    if (text.includes("pg_get_expr")) {
      const deparse = ownershipDeparse("owner")
      // The pinned probe both renders its own throwaway policy (named
      // mjb_probe_*) and deparses candidate policies by name; answer each
      // with the clauses that policy's template uses.
      const name = values?.[2]
      if (typeof name === "string" && !name.startsWith("mjb_probe_")) {
        for (const template of ["read", "insert", "update", "delete"] as const) {
          if (name === ownershipPolicyName("items", "owner", template)) {
            const shape = ownershipPolicyTemplateShape(template)
            return {
              ...empty,
              rows: [
                {
                  using: shape.using ? deparse : null,
                  check: shape.withCheck ? deparse : null,
                },
              ],
            } as never
          }
        }
      }
      const shape = probeShape ?? { using: true, withCheck: false }
      return {
        ...empty,
        rows: [
          {
            using: shape.using ? deparse : null,
            check: shape.withCheck ? deparse : null,
          },
        ],
      } as never
    }
    throw new Error(`unexpected preflight query: ${text}`)
  }
  return {
    query: dispatch,
    connect: async () => ({
      query: dispatch,
      release: () => undefined,
    }),
  } as unknown as Pool
}

describe("expose plan statement order (R6, JDW-28)", () => {
  it("runs the locked prerequisite guard before any GRANT", async () => {
    const { calls, executor } = fakeExecutor()
    const service = createSchemaExposureService({
      pool: fakeExposurePool(),
      catalogue: { read: async () => itemsCatalogue() },
      executor,
      adminRole: ADMIN_ROLE,
      runtimeRole: RUNTIME_ROLE,
      refreshRuntimeRegistry: async () => undefined,
    })
    const outcome = await service.expose({
      idempotencyKey: "r6-expose-order-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
      alias: "items",
    })
    expect(outcome.replayed).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.idempotencyKey).toBe("r6-expose-order-1")

    const plans = calls[0]?.plan as readonly {
      statements: readonly string[]
    }[]
    expect(plans).toHaveLength(3)
    const [guardPlan, grantPlan, markPlan] = plans
    expect(guardPlan?.statements).toHaveLength(1)
    const guard = guardPlan?.statements[0] ?? ""
    expect(guard).toContain("9C004")
    expect(guard).toContain("relrowsecurity")
    expect(guard).toContain("relforcerowsecurity")
    // The guard carries no GRANT of its own.
    expect(guard).not.toContain("GRANT")
    // Every statement of the grant plan is a GRANT...
    expect(grantPlan?.statements.length).toBeGreaterThan(0)
    for (const statement of grantPlan?.statements ?? []) {
      expect(statement).toContain("GRANT")
    }
    // ...and the mark plan records the durable registry row.
    expect(markPlan?.statements[0]).toContain(
      "INSERT INTO microjbase.exposure_registry",
    )
  })
})
