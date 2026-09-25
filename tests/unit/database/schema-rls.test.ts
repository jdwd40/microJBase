// Unit tests for the V02-14..V02-15 row-security commands and ownership
// policy templates. The catalogue reader, preflight pool, exposure registry,
// and the V02-06 executor are injected fakes, so these tests pin the guard
// matrix and the compiled statement shapes without a database.

import { describe, expect, it } from "vitest"

import type {
  SchemaCatalogue,
  SchemaCatalogueColumn,
  SchemaCatalogueSchema,
  SchemaCatalogueTable,
  TypeIdentity,
} from "../../../src/contracts/index.js"
import {
  compileCreateOwnershipPolicy,
  compileDisableRowSecurity,
  compileDropOwnershipPolicy,
  compileEnableRowSecurity,
  createSchemaPolicyService,
  createSchemaRlsService,
  deterministicObjectName,
  ownershipPolicyName,
  type ExecuteOutcome,
  type OwnershipPolicyTemplate,
  type SchemaDdlExecutor,
} from "../../../src/database/index.js"
import type {
  Pool,
  SchemaPolicyServiceDependencies,
  SchemaRlsServiceDependencies,
} from "../../../src/database/index.js"

const APP_SCHEMA = "app"
const ADMIN_ROLE = "mjb_admin"
const RUNTIME_ROLE = "mjb_runtime"

function typeIdentity(name: string): TypeIdentity {
  return { schema: "pg_catalog", name, kind: "base" }
}

interface ColumnOptions {
  readonly isNullable?: boolean
  readonly defaultExpression?: string | null
  readonly generated?: "none" | "stored" | "virtual"
  readonly identity?: "none" | "always" | "by_default"
  readonly renderedType?: string
}

function column(
  name: string,
  options: ColumnOptions = {},
): SchemaCatalogueColumn {
  const renderedType = options.renderedType ?? "text"
  return {
    ordinal: 1,
    name,
    isNullable: options.isNullable ?? true,
    defaultExpression: options.defaultExpression ?? null,
    generated: options.generated ?? "none",
    identity: options.identity ?? "none",
    renderedType,
    type: typeIdentity(renderedType),
    baseType: null,
  }
}

interface TableOptions {
  readonly owner?: string
  readonly columns?: readonly SchemaCatalogueColumn[]
  readonly rls?: { enabled: boolean; forced: boolean }
}

function table(name: string, options: TableOptions = {}): SchemaCatalogueTable {
  const rls = options.rls ?? { enabled: false, forced: false }
  return {
    schema: APP_SCHEMA,
    name,
    owner: options.owner ?? ADMIN_ROLE,
    kind: "regular",
    hasRowSecurity: rls.enabled,
    hasForcedRowSecurity: rls.forced,
    columns: options.columns ?? [
      column("id", { isNullable: false, renderedType: "uuid" }),
      column("owner", { isNullable: false, renderedType: "uuid" }),
      column("title", { isNullable: false }),
    ],
    constraints: [
      {
        name: `${name}_pkey`,
        classification: "primary_key",
        columns: ["id"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
    ],
    indexes: [],
  }
}

function catalogue(
  ...tables: readonly SchemaCatalogueTable[]
): SchemaCatalogue {
  const schema: SchemaCatalogueSchema = {
    name: APP_SCHEMA,
    owner: ADMIN_ROLE,
    tables,
  }
  return { schemas: [schema] }
}

interface CapturedCall {
  readonly plan: unknown
  readonly options: {
    readonly idempotencyKey: string
    readonly commandType: string
    readonly command: unknown
    readonly actor: string
    readonly dryRun?: boolean
  }
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

interface FakePoolOptions {
  /** Answer for the module-created policy existence probe. */
  readonly policyPresent?: boolean
  /** Seeded operation-log records by idempotency key. */
  readonly records?: Readonly<Record<string, Record<string, unknown>>>
}

function fakePool(options: FakePoolOptions = {}): Pool {
  return {
    query: async (text: string, values?: unknown[]) => {
      if (text.includes("FROM microjbase.schema_operations")) {
        const key = values?.[0]
        const row = typeof key === "string" ? options.records?.[key] : undefined
        return { rows: row === undefined ? [] : [row] } as never
      }
      if (text.includes("FROM pg_catalog.pg_policy")) {
        return {
          rows: [{ present: options.policyPresent ?? false }],
        } as never
      }
      throw new Error(`unexpected preflight query: ${text}`)
    },
  } as unknown as Pool
}

function seededRecord(
  key: string,
  commandType: string,
  command: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "1",
    idempotency_key: key,
    command_type: commandType,
    command,
    checksum: "c".repeat(64),
    status: "succeeded",
    actor_fingerprint: "f".repeat(64),
    error_code: null,
    result: null,
    created_at: new Date("2026-09-25T00:00:00.000Z"),
    finished_at: new Date("2026-09-25T00:00:01.000Z"),
  }
}

const INERT_REGISTRY = { get: () => null, list: () => [] }

function exposedRegistry(schema: string, tableName: string) {
  return {
    get: () => null,
    list: () => [
      {
        alias: "alias",
        schema,
        table: tableName,
        primaryKey: "id" as const,
        readableColumns: ["id"],
        insertableColumns: ["id"],
        updatableColumns: ["id"],
      },
    ],
  }
}

function makeRlsService(
  overrides: Omit<
    Partial<SchemaRlsServiceDependencies>,
    "catalogue" | "executor"
  > & {
    catalogue: SchemaCatalogue
    executor?: SchemaDdlExecutor
    pool?: Pool
    registry?: SchemaRlsServiceDependencies["registry"]
  },
) {
  const {
    catalogue,
    executor: overrideExecutor,
    pool,
    registry,
    ...rest
  } = overrides
  const { calls, executor } = fakeExecutor()
  const service = createSchemaRlsService({
    pool: pool ?? fakePool(),
    registry: registry ?? INERT_REGISTRY,
    adminRole: ADMIN_ROLE,
    ...rest,
    catalogue: { read: async () => catalogue },
    executor: overrideExecutor ?? executor,
  })
  return { service, calls }
}

function makePolicyService(
  overrides: Omit<
    Partial<SchemaPolicyServiceDependencies>,
    "catalogue" | "executor"
  > & {
    catalogue: SchemaCatalogue
    executor?: SchemaDdlExecutor
    pool?: Pool
  },
) {
  const { catalogue, executor: overrideExecutor, pool, ...rest } = overrides
  const { calls, executor } = fakeExecutor()
  const service = createSchemaPolicyService({
    pool: pool ?? fakePool(),
    adminRole: ADMIN_ROLE,
    runtimeRole: RUNTIME_ROLE,
    ...rest,
    catalogue: { read: async () => catalogue },
    executor: overrideExecutor ?? executor,
  })
  return { service, calls }
}

function rejection(
  promise: Promise<unknown>,
): Promise<Record<string, unknown>> {
  return promise.then(
    () => {
      throw new Error("expected the command to be rejected")
    },
    (error: unknown) => error as Record<string, unknown>,
  )
}

function statementsOf(call: CapturedCall | undefined): readonly string[] {
  return (call?.plan as { statements: readonly string[] }).statements
}

const OWNERSHIP_COMPARISON =
  "(\"owner\" = nullif(current_setting('microjbase.user_id', true), '')::uuid)"

describe("compileEnableRowSecurity", () => {
  it("enables and forces row-level security in one plan", () => {
    const plan = compileEnableRowSecurity({ schema: "app", table: "items" })
    expect(plan.statements).toEqual([
      'ALTER TABLE "app"."items" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "app"."items" FORCE ROW LEVEL SECURITY',
    ])
    expect(plan.description).toBe(
      "enable and force row-level security on app.items",
    )
  })

  it("refuses internal schemas and hostile identifiers", () => {
    for (const schema of ["microjbase", "PG_catalog", "information_schema"]) {
      expect(() =>
        compileEnableRowSecurity({ schema, table: "items" }),
      ).toThrow("Internal schemas cannot be modified")
    }
    expect(() =>
      compileEnableRowSecurity({
        schema: "app",
        table: 'items"; DROP TABLE x',
      }),
    ).toThrow("Invalid SQL identifier")
  })
})

describe("compileDisableRowSecurity", () => {
  it("drops the FORCE flag before disabling row-level security", () => {
    const plan = compileDisableRowSecurity({ schema: "app", table: "items" })
    expect(plan.statements).toEqual([
      'ALTER TABLE "app"."items" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "app"."items" DISABLE ROW LEVEL SECURITY',
    ])
  })

  it("refuses internal schemas before any SQL exists", () => {
    expect(() =>
      compileDisableRowSecurity({ schema: "pg_toast", table: "items" }),
    ).toThrow("Internal schemas cannot be modified")
  })
})

describe("ownership policy templates", () => {
  const spec = {
    schema: "app",
    table: "items",
    column: "owner",
    role: RUNTIME_ROLE,
  }

  it("read template compiles FOR SELECT with USING only", () => {
    const plan = compileCreateOwnershipPolicy({ ...spec, template: "read" })
    const name = ownershipPolicyName("items", "owner", "read")
    expect(plan.statements).toEqual([
      `CREATE POLICY "${name}" ON "app"."items" ` +
        `FOR SELECT TO "mjb_runtime" USING ${OWNERSHIP_COMPARISON}`,
    ])
  })

  it("insert template compiles FOR INSERT with WITH CHECK only", () => {
    const plan = compileCreateOwnershipPolicy({ ...spec, template: "insert" })
    const name = ownershipPolicyName("items", "owner", "insert")
    expect(plan.statements).toEqual([
      `CREATE POLICY "${name}" ON "app"."items" ` +
        `FOR INSERT TO "mjb_runtime" WITH CHECK ${OWNERSHIP_COMPARISON}`,
    ])
  })

  it("update template compiles FOR UPDATE with USING and WITH CHECK", () => {
    const plan = compileCreateOwnershipPolicy({ ...spec, template: "update" })
    const name = ownershipPolicyName("items", "owner", "update")
    expect(plan.statements).toEqual([
      `CREATE POLICY "${name}" ON "app"."items" ` +
        `FOR UPDATE TO "mjb_runtime" USING ${OWNERSHIP_COMPARISON} ` +
        `WITH CHECK ${OWNERSHIP_COMPARISON}`,
    ])
  })

  it("delete template compiles FOR DELETE with USING only", () => {
    const plan = compileCreateOwnershipPolicy({ ...spec, template: "delete" })
    const name = ownershipPolicyName("items", "owner", "delete")
    expect(plan.statements).toEqual([
      `CREATE POLICY "${name}" ON "app"."items" ` +
        `FOR DELETE TO "mjb_runtime" USING ${OWNERSHIP_COMPARISON}`,
    ])
  })

  it("derives deterministic module-owned names", () => {
    const first = deterministicObjectName("read", "items", ["owner"])
    const second = deterministicObjectName("read", "items", ["owner"])
    // The naming scheme is owned by the D-029 helper; what matters is that
    // the same command always derives the same in-range name.
    expect(first).toBe(second)
    expect(first.startsWith("mjb_items_owner_read")).toBe(true)
    expect(first.length).toBeLessThanOrEqual(63)
    expect(() =>
      compileCreateOwnershipPolicy({
        ...spec,
        template: "truncate" as OwnershipPolicyTemplate,
      }),
    ).toThrow("policy template")
  })

  it("refuses internal schemas, hostile identifiers, and hostile roles", () => {
    expect(() =>
      compileCreateOwnershipPolicy({
        ...spec,
        schema: "microjbase",
        template: "read",
      }),
    ).toThrow("Internal schemas cannot be modified")
    expect(() =>
      compileCreateOwnershipPolicy({
        ...spec,
        column: 'owner" OR true',
        template: "read",
      }),
    ).toThrow("Invalid SQL identifier")
    expect(() =>
      compileCreateOwnershipPolicy({
        ...spec,
        role: 'mjb_runtime"; SELECT 1',
        template: "read",
      }),
    ).toThrow("Invalid SQL identifier")
  })

  it("drop compiles the deterministic module-owned name", () => {
    const plan = compileDropOwnershipPolicy({
      schema: "app",
      table: "items",
      column: "owner",
      template: "delete",
    })
    const name = ownershipPolicyName("items", "owner", "delete")
    expect(plan.statements).toEqual([`DROP POLICY "${name}" ON "app"."items"`])
  })
})

describe("createSchemaRlsService", () => {
  it("enables and forces row-level security on an owned table", async () => {
    const { service, calls } = makeRlsService({
      catalogue: catalogue(table("items")),
    })
    const outcome = await service.enableRowSecurity({
      idempotencyKey: "rls-enable-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
    })
    expect(outcome.replayed).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.commandType).toBe("schema.rls.enable")
    expect(statementsOf(calls[0])).toEqual([
      'ALTER TABLE "app"."items" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "app"."items" FORCE ROW LEVEL SECURITY',
    ])
  })

  it("disables row-level security with the exact confirmation", async () => {
    const { service, calls } = makeRlsService({
      catalogue: catalogue(table("items")),
    })
    await service.disableRowSecurity({
      idempotencyKey: "rls-disable-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
      confirm: "app.items",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.commandType).toBe("schema.rls.disable")
    expect(statementsOf(calls[0])).toEqual([
      'ALTER TABLE "app"."items" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "app"."items" DISABLE ROW LEVEL SECURITY',
    ])
  })

  it("refuses disable without the exact confirmation", async () => {
    const { service, calls } = makeRlsService({
      catalogue: catalogue(table("items")),
    })
    const error = await rejection(
      service.disableRowSecurity({
        idempotencyKey: "rls-disable-bad-confirm",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
        confirm: "items",
      }),
    )
    expect(error["code"]).toBe("VALIDATION_ERROR")
    expect(calls).toHaveLength(0)
  })

  it("fails closed when disabling an exposed table", async () => {
    const { service, calls } = makeRlsService({
      catalogue: catalogue(table("items")),
      registry: exposedRegistry(APP_SCHEMA, "items"),
    })
    const error = await rejection(
      service.disableRowSecurity({
        idempotencyKey: "rls-disable-exposed",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
        confirm: "app.items",
      }),
    )
    expect(error["code"]).toBe("CONFLICT")
    expect(String(error["message"])).toMatch(/exposed/)
    expect(calls).toHaveLength(0)
  })

  it("refuses internal schemas and tables not owned by the schema-admin role", async () => {
    const { service, calls } = makeRlsService({
      catalogue: catalogue(table("items", { owner: "someone_else" })),
    })
    const foreign = await rejection(
      service.enableRowSecurity({
        idempotencyKey: "rls-enable-foreign",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
      }),
    )
    expect(foreign["code"]).toBe("VALIDATION_ERROR")
    const internal = await rejection(
      service.disableRowSecurity({
        idempotencyKey: "rls-disable-internal",
        actor: "operator",
        schema: "microjbase",
        table: "users",
        confirm: "microjbase.users",
      }),
    )
    expect(internal["code"]).toBe("VALIDATION_ERROR")
    expect(String(internal["message"])).toMatch(/Internal schemas/)
    expect(calls).toHaveLength(0)
  })

  it("rejects hostile identifiers before any preflight read", async () => {
    const { service, calls } = makeRlsService({
      catalogue: catalogue(table("items")),
    })
    const error = await rejection(
      service.enableRowSecurity({
        idempotencyKey: "rls-enable-hostile",
        actor: "operator",
        schema: APP_SCHEMA,
        table: 'items"; SELECT 1',
      }),
    )
    expect(error["code"]).toBe("VALIDATION_ERROR")
    expect(calls).toHaveLength(0)
  })

  it("hands a known key to the executor even when stateful guards would refuse", async () => {
    const key = "rls-replay-key"
    const { service, calls } = makeRlsService({
      // The table is gone from the catalogue and the registry claims it is
      // exposed; a recorded key must still reach the executor so the D-025
      // replay contract classifies the outcome.
      catalogue: catalogue(),
      registry: exposedRegistry(APP_SCHEMA, "items"),
      pool: fakePool({
        records: {
          [key]: seededRecord(key, "schema.rls.disable", {
            schema: APP_SCHEMA,
            table: "items",
            confirmed: true,
          }),
        },
      }),
    })
    await service.disableRowSecurity({
      idempotencyKey: key,
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
      confirm: "wrong-confirm-is-fine-on-replay",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.commandType).toBe("schema.rls.disable")
  })

  it("still runs guards for a dry run with a reused key", async () => {
    const key = "rls-dry-run-key"
    const { service, calls } = makeRlsService({
      catalogue: catalogue(table("items")),
      registry: exposedRegistry(APP_SCHEMA, "items"),
      pool: fakePool({
        records: {
          [key]: seededRecord(key, "schema.rls.disable", {
            schema: APP_SCHEMA,
            table: "items",
            confirmed: true,
          }),
        },
      }),
    })
    const error = await rejection(
      service.disableRowSecurity({
        idempotencyKey: key,
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
        confirm: "app.items",
        dryRun: true,
      }),
    )
    expect(error["code"]).toBe("CONFLICT")
    expect(calls).toHaveLength(0)
  })
})

describe("createSchemaPolicyService", () => {
  it("creates a template bound to the configured runtime role", async () => {
    const { service, calls } = makePolicyService({
      catalogue: catalogue(table("items")),
    })
    const outcome = await service.createOwnershipPolicy({
      idempotencyKey: "pol-create-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
      column: "owner",
      template: "update",
    })
    expect(outcome.replayed).toBe(false)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.options.commandType).toBe("schema.policy.create")
    expect(call?.options.command).toEqual({
      schema: APP_SCHEMA,
      table: "items",
      column: "owner",
      template: "update",
    })
    expect(statementsOf(call)).toEqual([
      `CREATE POLICY "${ownershipPolicyName("items", "owner", "update")}" ON "app"."items" ` +
        `FOR UPDATE TO "mjb_runtime" USING ${OWNERSHIP_COMPARISON} ` +
        `WITH CHECK ${OWNERSHIP_COMPARISON}`,
    ])
  })

  it("removes the named module-created policy", async () => {
    const { service, calls } = makePolicyService({
      catalogue: catalogue(table("items")),
      pool: fakePool({ policyPresent: true }),
    })
    await service.removeOwnershipPolicy({
      idempotencyKey: "pol-remove-1",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
      column: "owner",
      template: "read",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.commandType).toBe("schema.policy.remove")
    expect(statementsOf(calls[0])).toEqual([
      `DROP POLICY "${ownershipPolicyName("items", "owner", "read")}" ON "app"."items"`,
    ])
  })

  it("refuses non-uuid, missing, generated, and identity ownership columns", async () => {
    const { service, calls } = makePolicyService({
      catalogue: catalogue(
        table("items", {
          columns: [
            column("id", { isNullable: false, renderedType: "uuid" }),
            column("owner", { isNullable: false }),
            column("gen_owner", { generated: "stored", renderedType: "uuid" }),
            column("ident_owner", {
              identity: "by_default",
              renderedType: "uuid",
            }),
          ],
        }),
      ),
    })
    for (const [columnName, message] of [
      ["owner", "type uuid"],
      ["gen_owner", "Generated and identity"],
      ["ident_owner", "Generated and identity"],
      ["missing", "does not exist"],
    ] as const) {
      const error = await rejection(
        service.createOwnershipPolicy({
          idempotencyKey: `pol-create-${columnName}`,
          actor: "operator",
          schema: APP_SCHEMA,
          table: "items",
          column: columnName,
          template: "read",
        }),
      )
      expect(error["code"]).toBe(
        columnName === "missing" ? "TABLE_NOT_FOUND" : "VALIDATION_ERROR",
      )
      expect(String(error["message"])).toMatch(new RegExp(message))
    }
    expect(calls).toHaveLength(0)
  })

  it("refuses duplicate module-created policies and missing removals", async () => {
    const duplicateCase = makePolicyService({
      catalogue: catalogue(table("items")),
      pool: fakePool({ policyPresent: true }),
    })
    const duplicate = await rejection(
      duplicateCase.service.createOwnershipPolicy({
        idempotencyKey: "pol-create-dup",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
        column: "owner",
        template: "read",
      }),
    )
    expect(duplicate["code"]).toBe("CONFLICT")
    const missingCase = makePolicyService({
      catalogue: catalogue(table("items")),
      pool: fakePool({ policyPresent: false }),
    })
    const missing = await rejection(
      missingCase.service.removeOwnershipPolicy({
        idempotencyKey: "pol-remove-missing",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
        column: "owner",
        template: "delete",
      }),
    )
    expect(missing["code"]).toBe("CONFLICT")
    expect(String(missing["message"])).toMatch(/does not exist/)
    expect(duplicateCase.calls).toHaveLength(0)
    expect(missingCase.calls).toHaveLength(0)
  })

  it("refuses tables not owned by the schema-admin role and internal targets", async () => {
    const { service, calls } = makePolicyService({
      catalogue: catalogue(table("items", { owner: "someone_else" })),
    })
    const foreign = await rejection(
      service.createOwnershipPolicy({
        idempotencyKey: "pol-create-foreign",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "items",
        column: "owner",
        template: "read",
      }),
    )
    expect(foreign["code"]).toBe("VALIDATION_ERROR")
    const internal = await rejection(
      service.removeOwnershipPolicy({
        idempotencyKey: "pol-remove-internal",
        actor: "operator",
        schema: "pg_catalog",
        table: "items",
        column: "owner",
        template: "read",
      }),
    )
    expect(internal["code"]).toBe("VALIDATION_ERROR")
    expect(calls).toHaveLength(0)
  })

  it("hands a known key to the executor without re-running guards", async () => {
    const key = "pol-replay-key"
    const { service, calls } = makePolicyService({
      catalogue: catalogue(),
      pool: fakePool({
        records: {
          [key]: seededRecord(key, "schema.policy.remove", {
            schema: APP_SCHEMA,
            table: "items",
            column: "owner",
            template: "read",
          }),
        },
      }),
    })
    await service.removeOwnershipPolicy({
      idempotencyKey: key,
      actor: "operator",
      schema: APP_SCHEMA,
      table: "items",
      column: "owner",
      template: "read",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.commandType).toBe("schema.policy.remove")
  })
})
