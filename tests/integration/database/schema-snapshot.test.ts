import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"

import {
  checkSchemaMigrationsReadAccess,
  createPool,
  createSchemaSnapshotReader,
  readMigrationHistory,
  type SchemaCatalogueDependencies,
  type SchemaSnapshotDependencies,
} from "../../../src/database/index.js"
import type {
  SchemaSnapshot,
  TableRegistry,
} from "../../../src/contracts/index.js"
import { quoteLiteral } from "./helpers.js"
import {
  applyMigrationsAndGrants,
  cleanMigrations,
  withClient,
} from "./bootstrap.js"

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

const runtimeRoleName: string = new URL(databaseUrl).username

const APP_SCHEMA = "v0203_app"
const FIXTURE_SCHEMAS = [APP_SCHEMA] as const

const APPLIED_MIGRATIONS = [
  "0001_microjbase_schema.sql",
  "0002_auth_tables.sql",
  "0003_auth_token_hash_unique.sql",
  "0004_todos_table.sql",
  "0005_schema_operations.sql",
  "0006_exposure_registry.sql",
  "0007_exposure_registry_revoke_public.sql",
] as const

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>) {
  return withClient(adminDatabaseUrl as string, fn)
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// Stub implementing the frozen v0.1 TableRegistry contract; the snapshot
// service only reads alias/schema/table from each entry.
function buildRegistry(
  exposed: readonly { alias: string; schema: string; table: string }[],
): TableRegistry {
  const tables = exposed.map((entry) =>
    Object.freeze({
      alias: entry.alias,
      schema: entry.schema,
      table: entry.table,
      primaryKey: "id" as const,
      readableColumns: Object.freeze([] as readonly string[]),
      insertableColumns: Object.freeze([] as readonly string[]),
      updatableColumns: Object.freeze([] as readonly string[]),
    }),
  )
  return {
    get: (alias: string) =>
      tables.find((table) => table.alias === alias) ?? null,
    list: () => tables,
  }
}

async function createFixtures(): Promise<void> {
  await withAdminClient(async (admin) => {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(APP_SCHEMA)} CASCADE`)
    await admin.query(`CREATE SCHEMA ${quoteIdent(APP_SCHEMA)}`)
    await admin.query(`
      CREATE TABLE ${quoteIdent(APP_SCHEMA)}.tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL
      )
    `)
    await admin.query(`
      ALTER TABLE ${quoteIdent(APP_SCHEMA)}.tasks ENABLE ROW LEVEL SECURITY
    `)
    await admin.query(`
      ALTER TABLE ${quoteIdent(APP_SCHEMA)}.tasks FORCE ROW LEVEL SECURITY
    `)
  })
}

async function dropFixtures(): Promise<void> {
  await withAdminClient(async (admin) => {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(APP_SCHEMA)} CASCADE`)
  })
}

async function readSnapshot(registry: TableRegistry): Promise<SchemaSnapshot> {
  const reader = createSchemaSnapshotReader({
    query: ((text: string, values?: unknown[]) =>
      withAdminClient((client) =>
        client.query(text, values),
      )) as SchemaSnapshotDependencies["query"],
    registry,
  })
  return reader.readSnapshot()
}

describe("schema snapshot (real PostgreSQL)", () => {
  beforeAll(async () => {
    await cleanMigrations(adminDatabaseUrl)
    await applyMigrationsAndGrants(adminDatabaseUrl, runtimeRoleName)
    await createFixtures()
  })

  afterAll(async () => {
    await dropFixtures()
    await cleanMigrations(adminDatabaseUrl)
  })

  it("includes the full migration history in deterministic UTC rendering", async () => {
    const snapshot = await readSnapshot(buildRegistry([]))

    expect(snapshot.migrations.map((record) => record.filename)).toEqual([
      ...APPLIED_MIGRATIONS,
    ])
    for (const record of snapshot.migrations) {
      expect(record.checksum.length).toBeGreaterThan(0)
      expect(record.appliedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
      )
    }
  })

  it("renders applied_at identically regardless of the session timezone", async () => {
    const baseline = await withAdminClient((client) =>
      readMigrationHistory(((text: string, values?: unknown[]) =>
        client.query(text, values)) as SchemaCatalogueDependencies["query"]),
    )

    const client = new pg.Client({ connectionString: adminDatabaseUrl })
    await client.connect()
    try {
      await client.query("SET TIME ZONE 'Pacific/Auckland'")
      const shifted = await readMigrationHistory(((
        text: string,
        values?: unknown[],
      ) => client.query(text, values)) as SchemaCatalogueDependencies["query"])
      expect(JSON.stringify(shifted)).toBe(JSON.stringify(baseline))
    } finally {
      await client.end()
    }
  })

  it("classifies internal objects and never presents them as manageable", async () => {
    const snapshot = await readSnapshot(buildRegistry([]))
    const byName = new Map(
      snapshot.schemas.map((schema) => [schema.name, schema]),
    )

    const microjbase = byName.get("microjbase")
    expect(microjbase?.classification).toBe("internal")
    for (const table of microjbase?.tables ?? []) {
      expect(table.classification).toBe("internal")
      expect(table.exposure).toEqual({ exposed: false, alias: null })
    }

    expect(byName.get(APP_SCHEMA)?.classification).toBe("operator")
    expect(byName.get("public")?.classification).toBe("operator")
  })

  it("attaches current data-API exposure state from the registry", async () => {
    const snapshot = await readSnapshot(
      buildRegistry([{ alias: "tasks", schema: APP_SCHEMA, table: "tasks" }]),
    )
    const app = snapshot.schemas.find((schema) => schema.name === APP_SCHEMA)
    const tasks = app?.tables.find((table) => table.name === "tasks")

    expect(tasks).toMatchObject({
      classification: "operator",
      exposure: { exposed: true, alias: "tasks" },
      hasRowSecurity: true,
      hasForcedRowSecurity: true,
    })
    expect(tasks?.constraints).toEqual([
      {
        name: "tasks_pkey",
        classification: "primary_key",
        columns: ["id"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
    ])
  })

  it("returns deterministic snapshots across repeated reads", async () => {
    const registry = buildRegistry([
      { alias: "tasks", schema: APP_SCHEMA, table: "tasks" },
    ])
    const first = await readSnapshot(registry)
    const second = await readSnapshot(registry)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it("does not mutate the database across repeated snapshot reads", async () => {
    async function captureState() {
      return withAdminClient(async (admin) => {
        const fixtureSchemaLiterals = FIXTURE_SCHEMAS.map((s) =>
          quoteLiteral(s),
        ).join(",")
        const counts = await admin.query(`
          SELECT (SELECT count(*) FROM pg_catalog.pg_namespace) AS namespaces,
                 (SELECT count(*) FROM pg_catalog.pg_class) AS classes,
                 (SELECT count(*) FROM pg_catalog.pg_attrdef) AS attrdefs,
                 (SELECT count(*) FROM pg_catalog.pg_constraint) AS constraints
        `)
        const migrations = await admin.query(`
          SELECT filename, checksum, applied_at
          FROM microjbase.schema_migrations
          ORDER BY filename
        `)
        const objects = await admin.query(`
          SELECT n.nspname, c.relname, c.relkind
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN (${fixtureSchemaLiterals})
          ORDER BY n.nspname, c.relname
        `)
        return {
          counts: counts.rows,
          migrations: migrations.rows,
          objects: objects.rows,
        }
      })
    }

    const before = await captureState()
    const registry = buildRegistry([
      { alias: "tasks", schema: APP_SCHEMA, table: "tasks" },
    ])
    await readSnapshot(registry)
    await readSnapshot(registry)
    const after = await captureState()

    expect(after).toEqual(before)
  })

  it("checkSchemaMigrationsReadAccess resolves for the schema-admin role", async () => {
    await withAdminClient(async (admin) => {
      await expect(
        checkSchemaMigrationsReadAccess(admin),
      ).resolves.toBeUndefined()
    })
  })

  it("checkSchemaMigrationsReadAccess fails closed for a role without the SELECT grant", async () => {
    const NO_SELECT_ROLE = "mjb_snapshot_noselect"
    await withAdminClient(async (admin) => {
      // The role may survive a previous interrupted run holding its schema
      // grant, which blocks DROP ROLE until revoked.
      await admin.query(
        `DO $do$
           BEGIN
             IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${NO_SELECT_ROLE}') THEN
               EXECUTE format('REVOKE ALL ON SCHEMA microjbase FROM %I', '${NO_SELECT_ROLE}');
               EXECUTE format('DROP ROLE %I', '${NO_SELECT_ROLE}');
             END IF;
           END
         $do$`,
      )
      await admin.query(
        `CREATE ROLE ${quoteIdent(NO_SELECT_ROLE)} WITH LOGIN PASSWORD 'noselect_password' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
      )
      // A real admin lane always holds USAGE on the microjbase schema; the
      // probe targets the table grant only.
      await admin.query(
        `GRANT USAGE ON SCHEMA microjbase TO ${quoteIdent(NO_SELECT_ROLE)}`,
      )
    })
    const probeUrl = new URL(adminDatabaseUrl as string)
    probeUrl.username = NO_SELECT_ROLE
    probeUrl.password = "noselect_password"
    const probePool = createPool({
      databaseUrl: probeUrl.toString(),
      maxConnections: 2,
    })
    try {
      const client = await probePool.connect()
      try {
        await expect(checkSchemaMigrationsReadAccess(client)).rejects.toThrow(
          "missing required privilege SELECT on microjbase.schema_migrations",
        )
        await expect(
          checkSchemaMigrationsReadAccess(client),
        ).rejects.toMatchObject({
          code: "DATABASE_UNAVAILABLE",
          status: 503,
        })
      } finally {
        client.release()
      }
    } finally {
      await probePool.close()
      await withAdminClient(async (admin) => {
        await admin.query(
          `REVOKE ALL ON SCHEMA microjbase FROM ${quoteIdent(NO_SELECT_ROLE)}`,
        )
        await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(NO_SELECT_ROLE)}`)
      })
    }
  })
})
