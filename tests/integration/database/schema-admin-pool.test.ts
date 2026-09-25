// Integration tests for the V02-04 schema-admin capability boundary against
// real PostgreSQL roles.

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  assertSchemaAdminSessionDistinct,
  checkSchemaAdminRoleSafety,
  createPool,
  createSchemaAdminPool,
} from "../../../src/database/index.js"
import { applyMigrationsAndGrants, withClient } from "./bootstrap.js"
import { quoteIdentifier } from "./helpers.js"

const databaseUrl = process.env.INTEGRATION_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "INTEGRATION_DATABASE_URL environment variable is required for integration tests",
  )
}

const adminDatabaseUrl = process.env.INTEGRATION_ADMIN_DATABASE_URL
if (!adminDatabaseUrl) {
  throw new Error(
    "INTEGRATION_ADMIN_DATABASE_URL environment variable is required for integration tests",
  )
}

const SAFE_ROLE = "mjb_v0204_safe"
const BYPASS_ROLE = "mjb_v0204_bypass"
const CREATEROLE_ROLE = "mjb_v0204_createrole"
const CREATEDB_ROLE = "mjb_v0204_createdb"
const READ_ALL_ROLE = "mjb_v0204_read_all"
const TEST_ROLES = [
  SAFE_ROLE,
  BYPASS_ROLE,
  CREATEROLE_ROLE,
  CREATEDB_ROLE,
  READ_ALL_ROLE,
] as const

function roleUrl(role: string, password: string): string {
  const url = new URL(adminDatabaseUrl as string)
  url.username = role
  url.password = password
  return url.toString()
}

async function checkRole(role: string, password: string) {
  const pool = createSchemaAdminPool({
    databaseUrl: roleUrl(role, password),
  })
  try {
    const client = await pool.connect()
    try {
      return await checkSchemaAdminRoleSafety(client)
    } finally {
      client.release()
    }
  } finally {
    await pool.close()
  }
}

beforeAll(async () => {
  await applyMigrationsAndGrants(
    adminDatabaseUrl as string,
    new URL(databaseUrl as string).username,
  )

  await withClient(adminDatabaseUrl as string, async (admin) => {
    for (const role of TEST_ROLES) {
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`)
    }
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(SAFE_ROLE)} WITH LOGIN PASSWORD 'safe_password' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
    )
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(BYPASS_ROLE)} WITH LOGIN PASSWORD 'bypass_password' NOSUPERUSER BYPASSRLS NOCREATEROLE`,
    )
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(CREATEROLE_ROLE)} WITH LOGIN PASSWORD 'createrole_password' NOSUPERUSER NOBYPASSRLS CREATEROLE`,
    )
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(CREATEDB_ROLE)} WITH LOGIN PASSWORD 'createdb_password' NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB`,
    )
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(READ_ALL_ROLE)} WITH LOGIN PASSWORD 'read_all_password' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
    )
    await admin.query(
      `GRANT pg_read_all_data TO ${quoteIdentifier(READ_ALL_ROLE)}`,
    )
  })
})

afterAll(async () => {
  await withClient(adminDatabaseUrl as string, async (admin) => {
    for (const role of TEST_ROLES) {
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`)
    }
  })
})

describe("checkSchemaAdminRoleSafety with real PostgreSQL roles", () => {
  it("accepts a plain non-superuser, non-BYPASSRLS, non-CREATEROLE role", async () => {
    const result = await checkRole(SAFE_ROLE, "safe_password")
    expect(result).toEqual({
      role: SAFE_ROLE,
      isSuperuser: false,
      hasBypassRls: false,
      canCreateRole: false,
      canCreateDatabase: false,
      dangerousMemberships: [],
    })
  })

  it("rejects a superuser role", async () => {
    // The bootstrap admin role is a superuser in the test cluster, exactly
    // like the CI bootstrap user.
    const pool = createSchemaAdminPool({
      databaseUrl: adminDatabaseUrl as string,
    })
    try {
      const client = await pool.connect()
      try {
        await expect(checkSchemaAdminRoleSafety(client)).rejects.toThrow(
          "Schema-admin database role must not be a superuser",
        )
      } finally {
        client.release()
      }
    } finally {
      await pool.close()
    }
  })

  it("rejects a BYPASSRLS role before any operation executes", async () => {
    await expect(checkRole(BYPASS_ROLE, "bypass_password")).rejects.toThrow(
      "Schema-admin database role must not have BYPASSRLS",
    )
  })

  it("rejects a role with role-management rights", async () => {
    await expect(
      checkRole(CREATEROLE_ROLE, "createrole_password"),
    ).rejects.toThrow(
      "Schema-admin database role must not have role-management rights",
    )
  })

  it("rejects a role with the CREATEDB attribute", async () => {
    await expect(checkRole(CREATEDB_ROLE, "createdb_password")).rejects.toThrow(
      "Schema-admin database role must not have CREATEDB",
    )
  })

  it("rejects a role inheriting pg_read_all_data even with safe own attributes", async () => {
    await expect(checkRole(READ_ALL_ROLE, "read_all_password")).rejects.toThrow(
      "Schema-admin database role must not be a member of pg_read_all_data",
    )
  })

  it("rejection envelopes carry no database internals", async () => {
    await checkRole(BYPASS_ROLE, "bypass_password").catch((error: unknown) => {
      const envelope = (
        error as { toJSON: () => Record<string, unknown> }
      ).toJSON()
      expect(envelope).toEqual({
        code: "DATABASE_UNAVAILABLE",
        message: "Schema-admin database role must not have BYPASSRLS",
        status: 503,
      })
      expect(JSON.stringify(envelope)).not.toContain("rolbypassrls")
      expect(JSON.stringify(envelope)).not.toContain("true")
    })
  })
})

describe("assertSchemaAdminSessionDistinct with real sessions", () => {
  async function withSession<T>(
    role: string,
    password: string,
    fn: (client: import("pg").PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = createSchemaAdminPool({
      databaseUrl: roleUrl(role, password),
    })
    try {
      const client = await pool.connect()
      try {
        return await fn(client)
      } finally {
        client.release()
      }
    } finally {
      await pool.close()
    }
  }

  it("aborts when the admin session is the runtime session under another URL", async () => {
    // The runtime lane URL spells the role differently (hostname alias and
    // query parameter), but both sessions connect as the same role+database.
    const runtimeUrl = new URL(databaseUrl as string)
    const adminUrl = new URL(adminDatabaseUrl as string)
    adminUrl.username = runtimeUrl.username
    adminUrl.password = runtimeUrl.password
    adminUrl.searchParams.set("application_name", "admin-lane-alias")

    const runtimePool = createPool({ databaseUrl: databaseUrl as string })
    const aliasPool = createPool({ databaseUrl: adminUrl.toString() })
    try {
      const runtimeClient = await runtimePool.connect()
      const aliasClient = await aliasPool.connect()
      try {
        await expect(
          assertSchemaAdminSessionDistinct(runtimeClient, aliasClient),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
      } finally {
        runtimeClient.release()
        aliasClient.release()
      }
    } finally {
      await runtimePool.close()
      await aliasPool.close()
    }
  })

  it("accepts the admin lane as a different role on the same server", async () => {
    await withSession(SAFE_ROLE, "safe_password", async (adminClient) => {
      const runtimePool = createPool({ databaseUrl: databaseUrl as string })
      try {
        const runtimeClient = await runtimePool.connect()
        try {
          await expect(
            assertSchemaAdminSessionDistinct(runtimeClient, adminClient),
          ).resolves.toBeUndefined()
        } finally {
          runtimeClient.release()
        }
      } finally {
        await runtimePool.close()
      }
    })
  })
})
