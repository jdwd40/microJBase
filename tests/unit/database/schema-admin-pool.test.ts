// Unit tests for the V02-04 schema-admin capability boundary.

import { describe, expect, it } from "vitest"

import {
  SCHEMA_ADMIN_MAX_CONNECTIONS,
  assertSchemaAdminSessionDistinct,
  checkSchemaAdminRoleSafety,
  checkSchemaMigrationsReadAccess,
  checkSchemaOperationLogWriteAccess,
  createSchemaAdminPool,
} from "../../../src/database/index.js"

interface FakeRoleRow {
  rolname: string
  rolsuper: boolean
  rolbypassrls: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  member_pg_execute_server_program: boolean
  member_pg_write_server_files: boolean
  member_pg_read_all_data: boolean
  member_pg_write_all_data: boolean
}

function fakeRoleRow(overrides: Partial<FakeRoleRow> = {}): FakeRoleRow {
  return {
    rolname: "microjbase_schema",
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    member_pg_execute_server_program: false,
    member_pg_write_server_files: false,
    member_pg_read_all_data: false,
    member_pg_write_all_data: false,
    ...overrides,
  }
}

function fakeClient(rows: unknown[]) {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  } as never
}

describe("checkSchemaAdminRoleSafety", () => {
  it("accepts a non-superuser, non-BYPASSRLS role without CREATEROLE", async () => {
    const result = await checkSchemaAdminRoleSafety(fakeClient([fakeRoleRow()]))
    expect(result).toEqual({
      role: "microjbase_schema",
      isSuperuser: false,
      hasBypassRls: false,
      canCreateRole: false,
      canCreateDatabase: false,
      dangerousMemberships: [],
    })
  })

  it("rejects a superuser role before any operation executes", async () => {
    await expect(
      checkSchemaAdminRoleSafety(fakeClient([fakeRoleRow({ rolsuper: true })])),
    ).rejects.toThrow("Schema-admin database role must not be a superuser")
  })

  it("rejects a BYPASSRLS role", async () => {
    await expect(
      checkSchemaAdminRoleSafety(
        fakeClient([fakeRoleRow({ rolbypassrls: true })]),
      ),
    ).rejects.toThrow("Schema-admin database role must not have BYPASSRLS")
  })

  it("rejects a role with role-management rights (CREATEROLE)", async () => {
    await expect(
      checkSchemaAdminRoleSafety(
        fakeClient([fakeRoleRow({ rolcreaterole: true })]),
      ),
    ).rejects.toThrow(
      "Schema-admin database role must not have role-management rights (CREATEROLE)",
    )
  })

  it("rejects a role with the CREATEDB attribute", async () => {
    await expect(
      checkSchemaAdminRoleSafety(
        fakeClient([fakeRoleRow({ rolcreatedb: true })]),
      ),
    ).rejects.toThrow("Schema-admin database role must not have CREATEDB")
  })

  it.each([
    "pg_execute_server_program",
    "pg_write_server_files",
    "pg_read_all_data",
    "pg_write_all_data",
  ] as const)(
    "rejects membership in %s even when own attributes are safe",
    async (membership) => {
      await expect(
        checkSchemaAdminRoleSafety(
          fakeClient([fakeRoleRow({ [`member_${membership}`]: true })]),
        ),
      ).rejects.toThrow("Schema-admin database role must not be a member of")
    },
  )

  it("fails closed when the role cannot be determined", async () => {
    await expect(checkSchemaAdminRoleSafety(fakeClient([]))).rejects.toThrow(
      "Could not determine schema-admin database role",
    )
  })

  it("uses the DATABASE_UNAVAILABLE code like the v0.1 role checks", async () => {
    await expect(
      checkSchemaAdminRoleSafety(fakeClient([fakeRoleRow({ rolsuper: true })])),
    ).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", status: 503 })
  })
})

describe("assertSchemaAdminSessionDistinct", () => {
  function identityClient(identity: {
    user: string
    database: string
    server_addr: string | null
    server_port: number | null
  }) {
    return {
      query: async () => ({ rows: [identity], rowCount: 1 }),
    } as never
  }

  it("aborts when both sessions resolve to the same identity", async () => {
    const identity = {
      user: "microjbase_runtime",
      database: "appdb",
      server_addr: "127.0.0.1",
      server_port: 5432,
    }
    await expect(
      assertSchemaAdminSessionDistinct(
        identityClient(identity),
        identityClient(identity),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
  })

  it("accepts two different roles on the same server and database", async () => {
    await expect(
      assertSchemaAdminSessionDistinct(
        identityClient({
          user: "microjbase_runtime",
          database: "appdb",
          server_addr: "127.0.0.1",
          server_port: 5432,
        }),
        identityClient({
          user: "microjbase_schema",
          database: "appdb",
          server_addr: "127.0.0.1",
          server_port: 5432,
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("treats matching unix-socket sessions as the same identity", async () => {
    const identity = {
      user: "microjbase_runtime",
      database: "appdb",
      server_addr: null,
      server_port: null,
    }
    await expect(
      assertSchemaAdminSessionDistinct(
        identityClient(identity),
        identityClient(identity),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
  })
})

describe("checkSchemaOperationLogWriteAccess", () => {
  // The probe sends the privilege as a bind parameter, so the fake tracks
  // call order instead of matching SQL text: INSERT, UPDATE, then sequence
  // USAGE.
  function privilegeClient(failAtCall: number | null) {
    let calls = 0
    return {
      query: async () => {
        calls += 1
        const has = failAtCall === null || calls !== failAtCall
        return { rows: [{ has }], rowCount: 1 }
      },
    } as never
  }

  it("resolves when INSERT, UPDATE, and sequence USAGE are granted", async () => {
    await expect(
      checkSchemaOperationLogWriteAccess(privilegeClient(null)),
    ).resolves.toBeUndefined()
  })

  it("fails with a clear message when INSERT is missing", async () => {
    await expect(
      checkSchemaOperationLogWriteAccess(privilegeClient(1)),
    ).rejects.toThrow(
      "missing required privilege INSERT on microjbase.schema_operations",
    )
  })

  it("fails with a clear message when sequence USAGE is missing", async () => {
    await expect(
      checkSchemaOperationLogWriteAccess(privilegeClient(3)),
    ).rejects.toThrow(
      "missing required privilege USAGE on microjbase.schema_operations_id_seq",
    )
  })
})

describe("checkSchemaMigrationsReadAccess", () => {
  function privilegeClient(has: boolean | null) {
    // has === null simulates the privilege query returning no row.
    return {
      query: async () => ({
        rows: has === null ? [] : [{ has }],
        rowCount: has === null ? 0 : 1,
      }),
    } as never
  }

  it("resolves when SELECT on microjbase.schema_migrations is granted", async () => {
    await expect(
      checkSchemaMigrationsReadAccess(privilegeClient(true)),
    ).resolves.toBeUndefined()
  })

  it("fails closed with a clear message when SELECT is missing", async () => {
    await expect(
      checkSchemaMigrationsReadAccess(privilegeClient(false)),
    ).rejects.toThrow(
      "missing required privilege SELECT on microjbase.schema_migrations",
    )
    await expect(
      checkSchemaMigrationsReadAccess(privilegeClient(false)),
    ).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", status: 503 })
  })

  it("fails closed when the privilege query returns no row", async () => {
    await expect(
      checkSchemaMigrationsReadAccess(privilegeClient(null)),
    ).rejects.toThrow(
      "missing required privilege SELECT on microjbase.schema_migrations",
    )
  })
})

describe("createSchemaAdminPool", () => {
  it("creates a bounded pool over the schema-admin URL", () => {
    const pool = createSchemaAdminPool({
      databaseUrl: "postgres://schema:secret@127.0.0.1:5432/db",
    })
    expect(typeof pool.query).toBe("function")
    expect(typeof pool.connect).toBe("function")
    expect(typeof pool.close).toBe("function")
    expect(SCHEMA_ADMIN_MAX_CONNECTIONS).toBeLessThanOrEqual(10)
  })
})
