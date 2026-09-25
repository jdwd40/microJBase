// Unit tests for the V02-11..V02-13 DDL builders: indexes, unique
// constraints, foreign keys, and the exposure privilege/registry plans.
//
// These tests pin the compiled statement shapes, the allowlist refusals,
// and the sealed-plan property. Execution behaviour lives in the
// integration suite.

import { describe, expect, it } from "vitest"

import {
  compileAddForeignKey,
  compileAddUniqueConstraint,
  compileCreateIndex,
  compileDropConstraint,
  compileDropIndex,
  compileGrantRuntimePrivileges,
  compileMarkExposed,
  compileMarkUnexposed,
  compileRevokeRuntimePrivileges,
  compileVerifyRuntimePrivilegesRevoked,
  deterministicObjectName,
  describePlan,
  type DdlPlan,
} from "../../../src/database/index.js"

function expectStatement(plan: DdlPlan, statement: string): void {
  expect(plan.statements).toEqual([statement])
}

describe("compileCreateIndex", () => {
  it("compiles a CREATE INDEX with a deterministic name", () => {
    const plan = compileCreateIndex({
      schema: "app",
      table: "orders",
      columns: ["user_id", "created_at"],
    })
    expectStatement(
      plan,
      'CREATE INDEX "mjb_orders_user_id_created_at_idx_67df6c30" ON "app"."orders" ("user_id", "created_at")',
    )
  })

  it("honours a validated explicit name", () => {
    const plan = compileCreateIndex({
      schema: "app",
      table: "orders",
      columns: ["user_id"],
      name: "orders_user_idx",
    })
    expectStatement(
      plan,
      'CREATE INDEX "orders_user_idx" ON "app"."orders" ("user_id")',
    )
  })

  it("refuses internal schemas", () => {
    expect(() =>
      compileCreateIndex({
        schema: "microjbase",
        table: "users",
        columns: ["id"],
      }),
    ).toThrow(/Internal schemas/)
  })

  it("refuses expressions, hostile identifiers, and long names", () => {
    expect(() =>
      compileCreateIndex({
        schema: "app",
        table: "t",
        columns: ['lower("x")'],
      }),
    ).toThrow(/Invalid SQL identifier/)
    expect(() =>
      compileCreateIndex({ schema: "app", table: "t", columns: ["a;drop"] }),
    ).toThrow(/Invalid SQL identifier/)
    expect(() =>
      compileCreateIndex({
        schema: "app",
        table: "t",
        columns: ["id"],
        name: "x".repeat(64),
      }),
    ).toThrow(/at most 63/)
  })

  it("refuses empty and duplicate column lists", () => {
    expect(() =>
      compileCreateIndex({ schema: "app", table: "t", columns: [] }),
    ).toThrow(/at least one column/)
    expect(() =>
      compileCreateIndex({ schema: "app", table: "t", columns: ["a", "a"] }),
    ).toThrow(/more than once/)
  })
})

describe("compileDropIndex", () => {
  it("compiles DROP INDEX qualified by schema", () => {
    const plan = compileDropIndex({ schema: "app", name: "orders_idx" })
    expectStatement(plan, 'DROP INDEX "app"."orders_idx"')
  })

  it("refuses hostile names", () => {
    expect(() => compileDropIndex({ schema: "app", name: 'a";drop' })).toThrow(
      /Invalid SQL identifier/,
    )
  })
})

describe("compileAddUniqueConstraint", () => {
  it("compiles ADD CONSTRAINT UNIQUE with a deterministic name", () => {
    const plan = compileAddUniqueConstraint({
      schema: "app",
      table: "users",
      columns: ["email"],
    })
    expectStatement(
      plan,
      'ALTER TABLE "app"."users" ADD CONSTRAINT "mjb_users_email_uniq_7d6369d8" UNIQUE ("email")',
    )
  })
})

describe("compileDropConstraint", () => {
  it("compiles DROP CONSTRAINT", () => {
    const plan = compileDropConstraint({
      schema: "app",
      table: "users",
      name: "mjb_users_email_uniq",
    })
    expectStatement(
      plan,
      'ALTER TABLE "app"."users" DROP CONSTRAINT "mjb_users_email_uniq"',
    )
  })
})

describe("compileAddForeignKey", () => {
  const base = {
    schema: "app",
    table: "orders",
    columns: ["user_id"],
    references: { schema: "app", table: "users", columns: ["id"] },
  }

  it("compiles the frozen action allowlist", () => {
    const plan = compileAddForeignKey({
      ...base,
      onUpdate: "restrict",
      onDelete: "cascade",
    })
    expectStatement(
      plan,
      'ALTER TABLE "app"."orders" ADD CONSTRAINT "mjb_orders_user_id_fkey_bad656d5" ' +
        'FOREIGN KEY ("user_id") REFERENCES "app"."users" ("id") ' +
        "ON UPDATE RESTRICT ON DELETE CASCADE",
    )
  })

  it("accepts no_action and set_null", () => {
    const plan = compileAddForeignKey({
      ...base,
      onUpdate: "no_action",
      onDelete: "set_null",
    })
    expect(describePlan(plan)[0]).toContain(
      "ON UPDATE NO ACTION ON DELETE SET NULL",
    )
  })

  it("refuses actions outside the frozen allowlist", () => {
    expect(() =>
      compileAddForeignKey({
        ...base,
        onUpdate: "set_default" as never,
        onDelete: "cascade",
      }),
    ).toThrow(/not allowlisted/)
  })

  it("refuses mismatched column counts", () => {
    expect(() =>
      compileAddForeignKey({
        ...base,
        columns: ["a", "b"],
        onUpdate: "no_action",
        onDelete: "no_action",
      }),
    ).toThrow(/same number of columns/)
  })

  it("refuses internal referencing or referenced schemas", () => {
    expect(() =>
      compileAddForeignKey({
        ...base,
        schema: "pg_catalog",
        onUpdate: "no_action",
        onDelete: "no_action",
      }),
    ).toThrow(/Internal schemas/)
    expect(() =>
      compileAddForeignKey({
        ...base,
        references: { schema: "microjbase", table: "users", columns: ["id"] },
        onUpdate: "no_action",
        onDelete: "no_action",
      }),
    ).toThrow(/Internal schemas/)
  })
})

describe("deterministicObjectName", () => {
  it("is stable and truncates long bases while retaining the digest", () => {
    const columns = Array.from({ length: 12 }, (_, i) => `column_${String(i)}`)
    const name = deterministicObjectName("idx", "table", columns)
    expect(name).toBe(deterministicObjectName("idx", "table", columns))
    expect(name.length).toBeLessThanOrEqual(63)
    expect(name.endsWith("_idx")).toBe(false) // truncated base carries the digest
  })

  it("appends the identity digest to short bases", () => {
    expect(deterministicObjectName("fkey", "orders", ["user_id"])).toBe(
      "mjb_orders_user_id_fkey_bad656d5",
    )
  })

  it("disambiguates column lists that join to the same string", () => {
    // ["a_b","c"] and ["a","b_c"] both render mjb_t_a_b_c_idx without the
    // digest; the identity hash keeps them distinct (R5 review, JDW-23).
    const first = deterministicObjectName("idx", "t", ["a_b", "c"])
    const second = deterministicObjectName("idx", "t", ["a", "b_c"])
    expect(first).not.toBe(second)
    expect(first).toBe("mjb_t_a_b_c_idx_f568690c")
    expect(second).toBe("mjb_t_a_b_c_idx_8c3a6c81")
  })
})

describe("compileGrantRuntimePrivileges", () => {
  it("compiles schema usage, delete, and column-level grants", () => {
    const plan = compileGrantRuntimePrivileges({
      schema: "app",
      table: "todos",
      role: "microjbase_runtime",
      grantSchemaUsage: true,
      grantDelete: true,
      columnGrants: [
        { privilege: "SELECT", columns: ["id", "title"] },
        { privilege: "INSERT", columns: ["title"] },
        { privilege: "UPDATE", columns: ["title"] },
      ],
    })
    expect(plan.statements).toEqual([
      'GRANT USAGE ON SCHEMA "app" TO "microjbase_runtime"',
      'GRANT DELETE ON TABLE "app"."todos" TO "microjbase_runtime"',
      'GRANT SELECT ("id", "title") ON TABLE "app"."todos" TO "microjbase_runtime"',
      'GRANT INSERT ("title") ON TABLE "app"."todos" TO "microjbase_runtime"',
      'GRANT UPDATE ("title") ON TABLE "app"."todos" TO "microjbase_runtime"',
    ])
  })

  it("omits no statement when the grant list is empty", () => {
    expect(() =>
      compileGrantRuntimePrivileges({
        schema: "app",
        table: "todos",
        role: "microjbase_runtime",
        grantSchemaUsage: false,
        grantDelete: false,
        columnGrants: [],
      }),
    ).toThrow(/at least one statement/)
  })

  it("refuses a runtime role outside the identifier pattern", () => {
    expect(() =>
      compileGrantRuntimePrivileges({
        schema: "app",
        table: "todos",
        role: 'runtime";drop',
        grantSchemaUsage: true,
        grantDelete: false,
        columnGrants: [],
      }),
    ).toThrow(/Invalid SQL identifier/)
  })

  it("refuses a privilege token outside the runtime allowlist", () => {
    expect(() =>
      compileGrantRuntimePrivileges({
        schema: "app",
        table: "todos",
        role: "microjbase_runtime",
        grantSchemaUsage: false,
        grantDelete: true,
        columnGrants: [
          {
            privilege: "SELECT) ON TABLE app.todos TO PUBLIC; --" as never,
            columns: ["title"],
          },
        ],
      }),
    ).toThrow(/not allowlisted/)
  })
})

describe("compileRevokeRuntimePrivileges", () => {
  it("revokes exactly the granted DML privileges at table level", () => {
    const plan = compileRevokeRuntimePrivileges({
      schema: "app",
      table: "todos",
      role: "microjbase_runtime",
    })
    expectStatement(
      plan,
      'REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."todos" FROM "microjbase_runtime"',
    )
  })
})

describe("compileVerifyRuntimePrivilegesRevoked", () => {
  it("compiles a pg_catalog-qualified residual-privilege guard", () => {
    const plan = compileVerifyRuntimePrivilegesRevoked({
      schema: "app",
      table: "todos",
      role: "microjbase_runtime",
    })
    expect(plan.statements).toHaveLength(1)
    const statement = plan.statements[0] ?? ""
    expect(statement.startsWith("DO $microjbase$")).toBe(true)
    expect(statement).toContain(
      "pg_catalog.has_table_privilege('microjbase_runtime', 'app.todos', 'DELETE')",
    )
    expect(statement).toContain(
      "pg_catalog.has_column_privilege('microjbase_runtime', 'app.todos', a.attname, 'SELECT')",
    )
    expect(statement).toContain("USING ERRCODE = '9C002'")
    // No unqualified catalogue reference anywhere in the guard.
    expect(statement).not.toMatch(/(?<!pg_catalog\.)\bpg_class\b/)
    expect(statement).not.toMatch(/(?<!pg_catalog\.)\bpg_namespace\b/)
    expect(statement).not.toMatch(/(?<!pg_catalog\.)\bpg_attribute\b/)
  })

  it("refuses internal schemas and hostile identifiers", () => {
    expect(() =>
      compileVerifyRuntimePrivilegesRevoked({
        schema: "microjbase",
        table: "todos",
        role: "microjbase_runtime",
      }),
    ).toThrow(/Internal schemas/)
    expect(() =>
      compileVerifyRuntimePrivilegesRevoked({
        schema: "app",
        table: "todos",
        role: 'runtime";drop',
      }),
    ).toThrow(/Invalid SQL identifier/)
  })
})

describe("exposure registry statements", () => {
  it("markExposed upserts the durable row with validated literals", () => {
    const plan = compileMarkExposed({
      alias: "todos",
      schema: "app",
      table: "todos",
    })
    expect(plan.statements).toHaveLength(1)
    expect(plan.statements[0]).toContain(
      "INSERT INTO microjbase.exposure_registry",
    )
    expect(plan.statements[0]).toContain("'todos'")
    expect(plan.statements[0]).toContain(
      "ON CONFLICT (schema_name, table_name) DO UPDATE",
    )
  })

  it("markUnexposed flips the durable row without deleting it", () => {
    const plan = compileMarkUnexposed({ schema: "app", table: "todos" })
    expect(plan.statements).toHaveLength(1)
    expect(plan.statements[0]).toContain("SET exposed = FALSE")
    expect(plan.statements[0]).not.toContain("DELETE")
  })

  it("refuses hostile aliases and identifiers", () => {
    expect(() =>
      compileMarkExposed({ alias: "x');drop", schema: "app", table: "t" }),
    ).toThrow()
    expect(() =>
      compileMarkExposed({ alias: "ok", schema: 'app";drop', table: "t" }),
    ).toThrow()
    expect(() =>
      compileMarkUnexposed({ schema: "app", table: "t;drop" }),
    ).toThrow()
  })
})

describe("plan sealing", () => {
  it("plans from every builder are sealed for the executor", () => {
    // The executor refuses unsealed plans; sealing is checked by identity
    // in the integration suite. Here we only pin that builders freeze the
    // statement list so callers cannot mutate compiled SQL.
    const plan = compileCreateIndex({
      schema: "app",
      table: "t",
      columns: ["id"],
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.statements)).toBe(true)
  })
})
