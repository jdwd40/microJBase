// Integration tests for the JDW-30 blockers from the JDW-29 re-review,
// run against real PostgreSQL 18.6:
//
//  1. (Blocker) expose refuses a table that participates in a CASCADE/SET
//     NULL foreign key created while both ends were unexposed. The
//     compileAddForeignKey guard only watches mutations that run while an
//     end is already exposed, so the cascade could be planted first and the
//     parent exposed afterwards; the locked exposure-prerequisite guard now
//     re-reads pg_constraint under the advisory lock and the whole expose
//     rolls back (9C004 -> CONFLICT 409).
//  2. (Blocker) the ownership-comparison probe and the candidate-policy
//     deparse are pinned to search_path = pg_catalog. A policy planted with
//     a hostile search_path whose uuid = operator always returns true used
//     to deparse to the identical string the probe renders, so verification
//     accepted it and one tenant could read another's rows; the pinned
//     deparse exposes the operator qualification and fails closed, while a
//     genuine pg_catalog policy still exposes.
//
// Verification command (PostgreSQL 18.6, workspace-local cluster):
//   INTEGRATION_DATABASE_URL=postgres://microjbase_runtime@127.0.0.1:55432/microjbase_integration_test \
//   INTEGRATION_ADMIN_DATABASE_URL=postgres://microjbase@127.0.0.1:55432/microjbase_integration_test \
//   npx vitest run --project integration tests/integration/database/jdw30-guards.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import pg from "pg"

import type { SchemaCatalogueReader } from "../../../src/contracts/index.js"
import {
  buildTableRegistry,
  createSchemaCatalogueReader,
  createSchemaConstraintService,
  createSchemaDdlExecutor,
  createSchemaExposureService,
  createSchemaMutationService,
  createSchemaOperationLog,
  createSwappableTableRegistry,
  createPool,
  type ManagedColumnSpec,
  ownershipPolicyName,
  ownershipPolicyTemplateShape,
  type Pool,
  readExposureRegistryState,
  type SchemaConstraintService,
  type SchemaExposureService,
  type SchemaMutationService,
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

const RUNTIME_ROLE = new URL(databaseUrl as string).username
const ADMIN_ROLE = "mjb_jdw30_admin"
const ADMIN_ROLE_PASSWORD = "jdw30_admin_password"
const APP_SCHEMA = "mjb_jdw30_app"
const EVIL_SCHEMA = "jdw30_evil"

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"

function adminRoleUrl(): string {
  const url = new URL(adminDatabaseUrl as string)
  url.username = ADMIN_ROLE
  url.password = ADMIN_ROLE_PASSWORD
  return url.toString()
}

let adminPool: Pool
let catalogue: SchemaCatalogueReader
let mutations: SchemaMutationService
let constraints: SchemaConstraintService
let exposure: SchemaExposureService
let holder: ReturnType<typeof createSwappableTableRegistry>

const TEXT_COLUMN = {
  name: "title",
  type: "text" as const,
  nullable: false,
  default: { kind: "none" as const },
}

const OWNER_COLUMN: ManagedColumnSpec = {
  name: "owner",
  type: "uuid" as const,
  nullable: false,
  default: { kind: "none" as const },
}

const PARENT_ID_COLUMN: ManagedColumnSpec = {
  name: "parent_id",
  type: "uuid" as const,
  nullable: true,
  default: { kind: "none" as const },
}

// The frozen comparison text every ownership template compiles; identical to
// what the module compiler emits, so a policy created from it under a
// hostile search_path deparse-matches the genuine rendering there.
const COMPARISON =
  "(owner = nullif(current_setting('microjbase.user_id', true), '')::uuid)"

async function createManagedTable(
  table: string,
  extraColumns: readonly ManagedColumnSpec[] = [],
): Promise<void> {
  const outcome = await mutations.createTable({
    idempotencyKey: `jdw30-setup-${table}`,
    actor: "setup",
    schema: APP_SCHEMA,
    table,
    columns: [TEXT_COLUMN, ...extraColumns],
  })
  expect(outcome.replayed).toBe(false)
}

// RLS + FORCE + the four module-named ownership policies verification needs.
async function hardenTable(table: string): Promise<void> {
  await withClient(adminRoleUrl(), async (client) => {
    const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(table)}`
    await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
    await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
    for (const template of ["read", "insert", "update", "delete"] as const) {
      const shape = ownershipPolicyTemplateShape(template)
      let statement =
        `CREATE POLICY ${quoteIdentifier(ownershipPolicyName(table, "owner", template))} ` +
        `ON ${qualified} FOR ${shape.command} TO PUBLIC`
      if (shape.using) statement += ` USING ${COMPARISON}`
      if (shape.withCheck) statement += ` WITH CHECK ${COMPARISON}`
      await client.query(statement)
    }
  })
}

async function exposedInRegistry(table: string): Promise<boolean> {
  const state = await readExposureRegistryState({
    query: (text, values) => adminPool.query(text, values),
  })
  return state.exposed.some(
    (entry) => entry.schema === APP_SCHEMA && entry.table === table,
  )
}

async function runtimeHasTablePrivilege(
  table: string,
  privilege: string,
): Promise<boolean> {
  return withClient(adminRoleUrl(), async (client) => {
    const result = await client.query<{ has: boolean }>(
      `SELECT pg_catalog.has_table_privilege($1, $2, $3) AS has`,
      [RUNTIME_ROLE, `${APP_SCHEMA}.${table}`, privilege],
    )
    return result.rows[0]?.has === true
  })
}

async function refreshRuntimeRegistry(): Promise<void> {
  const state = await readExposureRegistryState({
    query: (text, values) => adminPool.query(text, values),
  })
  holder.replace(
    await buildTableRegistry(
      { mappings: state.exposed },
      { query: (text, values) => adminPool.query(text, values) },
    ),
  )
}

async function dropAdminRole(admin: pg.Client): Promise<void> {
  await admin.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ADMIN_ROLE}') THEN
        EXECUTE 'DROP SCHEMA IF EXISTS ${APP_SCHEMA} CASCADE';
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA microjbase FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA microjbase FROM "${ADMIN_ROLE}"';
        EXECUTE 'REVOKE USAGE ON SCHEMA microjbase FROM "${ADMIN_ROLE}"';
        EXECUTE 'DROP ROLE "${ADMIN_ROLE}"';
      END IF;
    END
    $$;
  `)
}

beforeAll(async () => {
  await applyMigrationsAndGrants(adminDatabaseUrl as string, RUNTIME_ROLE)

  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'jdw30-%'`,
    )
    await admin.query("TRUNCATE microjbase.exposure_registry")
    await admin.query(
      "UPDATE microjbase.exposure_registry_state SET initialized = TRUE, imported_at = now()",
    )
    await dropAdminRole(admin)
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(ADMIN_ROLE)} WITH LOGIN PASSWORD '${ADMIN_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
    )
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await admin.query(
      `CREATE SCHEMA ${quoteIdentifier(APP_SCHEMA)} AUTHORIZATION ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT USAGE ON SCHEMA microjbase TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON microjbase.schema_operations TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT USAGE ON SEQUENCE microjbase.schema_operations_id_seq TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON microjbase.exposure_registry TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT USAGE ON SEQUENCE microjbase.exposure_registry_id_seq TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
    await admin.query(
      `GRANT SELECT ON microjbase.exposure_registry_state TO ${quoteIdentifier(ADMIN_ROLE)}`,
    )
  })

  adminPool = createPool({ databaseUrl: adminRoleUrl(), maxConnections: 6 })
  catalogue = createSchemaCatalogueReader({
    query: (text, values) => adminPool.query(text, values),
  })
  const executor = createSchemaDdlExecutor({
    pool: adminPool,
    createOperationLog: (query) => createSchemaOperationLog({ query }),
  })
  holder = createSwappableTableRegistry(
    await buildTableRegistry({ mappings: [] }, { query: adminPool.query }),
  )
  mutations = createSchemaMutationService({
    pool: adminPool,
    catalogue,
    registry: holder,
    adminRole: ADMIN_ROLE,
    executor,
  })
  constraints = createSchemaConstraintService({
    pool: adminPool,
    catalogue,
    adminRole: ADMIN_ROLE,
    executor,
  })
  exposure = createSchemaExposureService({
    pool: adminPool,
    catalogue,
    executor,
    adminRole: ADMIN_ROLE,
    runtimeRole: RUNTIME_ROLE,
    refreshRuntimeRegistry,
  })
})

afterAll(async () => {
  await adminPool.close()
  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(EVIL_SCHEMA)} CASCADE`,
    )
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await dropAdminRole(admin)
  })
})

describe("expose refuses pre-existing cascading foreign keys (JDW-29 blocker 1)", () => {
  it("refuses both ends of a cascade planted while unexposed and preserves the other tenant's row", async () => {
    // Create unhardened, seed both tenants while the owner lane can still
    // write any tenant's rows without satisfying the ownership WITH CHECK
    // policy, then harden.
    await createManagedTable("g_parent", [OWNER_COLUMN])
    await createManagedTable("g_child", [OWNER_COLUMN, PARENT_ID_COLUMN])
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = (t: string): string =>
        `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier(t)}`
      await client.query(
        `INSERT INTO ${qualified("g_parent")} (title, owner) VALUES ('alice note', $1::uuid), ('bob note', $2::uuid)`,
        [ALICE, BOB],
      )
      await client.query(
        `INSERT INTO ${qualified("g_child")} (title, owner, parent_id)
           SELECT 'alice comment', $1::uuid, id FROM ${qualified("g_parent")} WHERE owner = $1::uuid
           UNION ALL
           SELECT 'bob comment', $2::uuid, id FROM ${qualified("g_parent")} WHERE owner = $2::uuid`,
        [ALICE, BOB],
      )
    })
    await hardenTable("g_parent")
    await hardenTable("g_child")

    // The CASCADE constraint is created while NEITHER end is exposed, so
    // compileAddForeignKey's exposed-end guard does not apply; this is the
    // sequence the JDW-29 review proved breaks tenant isolation.
    const fk = await constraints.addForeignKey({
      idempotencyKey: "jdw30-fk-g-cascade",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g_child",
      columns: ["parent_id"],
      references: { schema: APP_SCHEMA, table: "g_parent", columns: ["id"] },
      onUpdate: "no_action",
      onDelete: "cascade",
    })
    expect(fk.replayed).toBe(false)

    // Exposing either end must conflict under the advisory lock (9C004 -> 409)
    // even though the in-memory preflight sees nothing wrong.
    await expect(
      exposure.expose({
        idempotencyKey: "jdw30-expose-g-parent",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g_parent",
        alias: "g_parent",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    await expect(
      exposure.expose({
        idempotencyKey: "jdw30-expose-g-child",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g_child",
        alias: "g_child",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    // The whole exposure rolled back: no registry row, no residual grants.
    expect(await exposedInRegistry("g_parent")).toBe(false)
    expect(await exposedInRegistry("g_child")).toBe(false)
    expect(await runtimeHasTablePrivilege("g_parent", "SELECT")).toBe(false)
    expect(await runtimeHasTablePrivilege("g_child", "SELECT")).toBe(false)

    // The other tenant's row was never reachable and is still present. The
    // bootstrap superuser reads through RLS; the hardened admin lane cannot.
    await withClient(adminDatabaseUrl as string, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g_child")} WHERE title = 'bob comment'`,
      )
      expect(result.rows[0]?.count).toBe("1")
    })
  })
})

describe("ownership probe pins search_path (JDW-29 blocker 2)", () => {
  beforeAll(async () => {
    // The hostile schema shadows uuid =(uuid,uuid) with an always-true
    // operator, exactly the planting the JDW-29 review reproduced.
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(EVIL_SCHEMA)} CASCADE`,
      )
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(EVIL_SCHEMA)}`)
      await admin.query(
        `CREATE FUNCTION ${quoteIdentifier(EVIL_SCHEMA)}.always_true(uuid, uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true'`,
      )
      await admin.query(
        `CREATE OPERATOR ${quoteIdentifier(EVIL_SCHEMA)}.= (PROCEDURE = ${quoteIdentifier(EVIL_SCHEMA)}.always_true, LEFTARG = uuid, RIGHTARG = uuid)`,
      )
      // Without USAGE the planting role cannot resolve the hostile operator
      // and CREATE POLICY would silently bind pg_catalog's genuine `=`,
      // making the planted policies indistinguishable from real ones (the
      // pinned deparse renders unqualified and verification accepts, which
      // is the correct behavior for a genuinely-frozen comparison).
      await admin.query(
        `GRANT USAGE ON SCHEMA ${quoteIdentifier(EVIL_SCHEMA)} TO ${quoteIdentifier(ADMIN_ROLE)}`,
      )
    })
  })

  // An exposure service whose admin pool resolves names through the hostile
  // schema first: the verifier and the probe both run on this pool.
  function hostileExposure(): { service: SchemaExposureService; close: () => Promise<void> } {
    const url = new URL(adminRoleUrl())
    url.searchParams.set(
      "options",
      `-c search_path=${EVIL_SCHEMA},pg_catalog`,
    )
    const pool = createPool({ databaseUrl: url.toString(), maxConnections: 4 })
    return {
      service: createSchemaExposureService({
        pool,
        catalogue,
        executor: createSchemaDdlExecutor({
          pool,
          createOperationLog: (query) => createSchemaOperationLog({ query }),
        }),
        adminRole: ADMIN_ROLE,
        runtimeRole: RUNTIME_ROLE,
        refreshRuntimeRegistry,
      }),
      close: () => pool.close(),
    }
  }

  it("rejects an ownership policy whose comparison resolved through a hostile operator", async () => {
    await createManagedTable("g_evil", [OWNER_COLUMN])
    // Plant module-named policies whose frozen comparison text bound the
    // always-true operator: under a hostile search_path both the planted
    // policy and the unpinned probe deparse to the identical string, which
    // used to verify; under the pinned search_path the operator renders
    // qualified and verification must fail closed.
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g_evil")}`
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
      await client.query(
        `SET search_path = ${quoteIdentifier(EVIL_SCHEMA)}, pg_catalog`,
      )
      for (const template of ["read", "insert", "update", "delete"] as const) {
        const shape = ownershipPolicyTemplateShape(template)
        let statement =
          `CREATE POLICY ${quoteIdentifier(ownershipPolicyName("g_evil", "owner", template))} ` +
          `ON ${qualified} FOR ${shape.command} TO PUBLIC`
        if (shape.using) statement += ` USING ${COMPARISON}`
        if (shape.withCheck) statement += ` WITH CHECK ${COMPARISON}`
        await client.query(statement)
      }
    })

    const hostile = hostileExposure()
    try {
      await expect(
        hostile.service.expose({
          idempotencyKey: "jdw30-expose-g-evil",
          actor: "operator",
          schema: APP_SCHEMA,
          table: "g_evil",
          alias: "g_evil",
        }),
      ).rejects.toThrow(/no managed read ownership policy/)
      expect(await exposedInRegistry("g_evil")).toBe(false)
    } finally {
      await hostile.close()
    }
  })

  it("still exposes a genuine pg_catalog ownership policy under a hostile search_path", async () => {
    await createManagedTable("g_genuine", [OWNER_COLUMN])
    await withClient(adminRoleUrl(), async (client) => {
      const qualified = `${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g_genuine")}`
      await client.query(
        `INSERT INTO ${qualified} (title, owner) VALUES ('alice note', $1::uuid), ('bob note', $2::uuid)`,
        [ALICE, BOB],
      )
    })
    // Genuine module policies compiled under the default search_path: their
    // stored operator is pg_catalog.=. They must still verify (and therefore
    // expose) even when the verification pool carries the hostile path.
    await hardenTable("g_genuine")

    const hostile = hostileExposure()
    try {
      const outcome = await hostile.service.expose({
        idempotencyKey: "jdw30-expose-g-genuine",
        actor: "operator",
        schema: APP_SCHEMA,
        table: "g_genuine",
        alias: "g_genuine",
      })
      expect(outcome.replayed).toBe(false)
      expect(outcome.record?.status).toBe("succeeded")
      expect(await exposedInRegistry("g_genuine")).toBe(true)

      // The exposed table honours the ownership policy: Alice's runtime
      // session sees only her row even though the policy expressions were
      // verified through a hostile-search_path pool.
      await withClient(databaseUrl as string, async (client) => {
        await client.query(`SELECT set_config('microjbase.user_id', $1, false)`, [
          ALICE,
        ])
        const result = await client.query<{ title: string }>(
          `SELECT title FROM ${quoteIdentifier(APP_SCHEMA)}.${quoteIdentifier("g_genuine")} ORDER BY title`,
        )
        expect(result.rows.map((row) => row.title)).toEqual(["alice note"])
      })
    } finally {
      await hostile.close()
    }

    await exposure.unexpose({
      idempotencyKey: "jdw30-unexpose-g-genuine",
      actor: "operator",
      schema: APP_SCHEMA,
      table: "g_genuine",
    })
  })
})
