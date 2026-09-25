// Unit tests for the V02-04 schema-admin capability boundary.

import { describe, expect, it } from "vitest"

import {
  SCHEMA_ADMIN_MAX_CONNECTIONS,
  checkSchemaAdminRoleSafety,
  createSchemaAdminPool,
} from "../../../src/database/index.js"

interface FakeRoleRow {
  rolname: string
  rolsuper: boolean
  rolbypassrls: boolean
  rolcreaterole: boolean
}

function fakeClient(rows: FakeRoleRow[]) {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  } as never
}

const SAFE_ROLE: FakeRoleRow = {
  rolname: "microjbase_schema",
  rolsuper: false,
  rolbypassrls: false,
  rolcreaterole: false,
}

describe("checkSchemaAdminRoleSafety", () => {
  it("accepts a non-superuser, non-BYPASSRLS role without CREATEROLE", async () => {
    const result = await checkSchemaAdminRoleSafety(fakeClient([SAFE_ROLE]))
    expect(result).toEqual({
      role: "microjbase_schema",
      isSuperuser: false,
      hasBypassRls: false,
      canCreateRole: false,
    })
  })

  it("rejects a superuser role before any operation executes", async () => {
    await expect(
      checkSchemaAdminRoleSafety(
        fakeClient([{ ...SAFE_ROLE, rolsuper: true }]),
      ),
    ).rejects.toThrow("Schema-admin database role must not be a superuser")
  })

  it("rejects a BYPASSRLS role", async () => {
    await expect(
      checkSchemaAdminRoleSafety(
        fakeClient([{ ...SAFE_ROLE, rolbypassrls: true }]),
      ),
    ).rejects.toThrow("Schema-admin database role must not have BYPASSRLS")
  })

  it("rejects a role with role-management rights (CREATEROLE)", async () => {
    await expect(
      checkSchemaAdminRoleSafety(
        fakeClient([{ ...SAFE_ROLE, rolcreaterole: true }]),
      ),
    ).rejects.toThrow(
      "Schema-admin database role must not have role-management rights (CREATEROLE)",
    )
  })

  it("fails closed when the role cannot be determined", async () => {
    await expect(checkSchemaAdminRoleSafety(fakeClient([]))).rejects.toThrow(
      "Could not determine schema-admin database role",
    )
  })

  it("uses the DATABASE_UNAVAILABLE code like the v0.1 role checks", async () => {
    await expect(
      checkSchemaAdminRoleSafety(
        fakeClient([{ ...SAFE_ROLE, rolsuper: true }]),
      ),
    ).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", status: 503 })
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
