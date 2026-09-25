// Integration tests for the V02-10 durable exposure registry against real
// PostgreSQL: clean-install import, the one-time MICROJBASE_TABLES import,
// the v0.1-to-v0.2 upgrade path with data preservation, the authoritative
// registry semantics (environment cannot add or re-expose), and the
// verified runtime registry built from the durable state.

import { mkdtemp, copyFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  buildTableRegistry,
  importInitialExposure,
  readExposureRegistryState,
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

const APP_SCHEMA = "mjb_v0210_app"

async function runtimeQueryFn(
  text: string,
  values?: unknown[],
): Promise<import("pg").QueryResult> {
  return withClient(databaseUrl as string, (client) =>
    client.query(text, values),
  )
}

async function resetRegistry(): Promise<void> {
  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query("TRUNCATE microjbase.exposure_registry")
    await admin.query(
      "UPDATE microjbase.exposure_registry_state SET initialized = FALSE, imported_at = NULL",
    )
  })
}

async function registryRows(): Promise<
  { alias: string; schema_name: string; table_name: string; exposed: boolean }[]
> {
  return withClient(adminDatabaseUrl as string, async (admin) => {
    const result = await admin.query(
      "SELECT alias, schema_name, table_name, exposed FROM microjbase.exposure_registry ORDER BY alias",
    )
    return result.rows as {
      alias: string
      schema_name: string
      table_name: string
      exposed: boolean
    }[]
  })
}

beforeAll(async () => {
  await applyMigrationsAndGrants(
    adminDatabaseUrl as string,
    new URL(databaseUrl as string).username,
  )
  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(APP_SCHEMA)}`)
    await createExposableTableWithClient(admin, APP_SCHEMA, "todos")
    await createExposableTableWithClient(admin, APP_SCHEMA, "notes")
  })
})

async function createExposableTableWithClient(
  admin: import("pg").Client,
  schema: string,
  table: string,
): Promise<void> {
  await admin.query(
    `CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       title TEXT NOT NULL
     )`,
  )
  await admin.query(
    `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ENABLE ROW LEVEL SECURITY`,
  )
  await admin.query(
    `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} FORCE ROW LEVEL SECURITY`,
  )
  await admin.query(
    `CREATE POLICY ${quoteIdentifier(`${table}_owner_all`)} ON ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
       FOR ALL TO PUBLIC
       USING (true) WITH CHECK (true)`,
  )
  await admin.query(
    `GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(new URL(databaseUrl as string).username)}`,
  )
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdentifier(schema)}.${quoteIdentifier(table)} TO ${quoteIdentifier(new URL(databaseUrl as string).username)}`,
  )
}

afterAll(async () => {
  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(APP_SCHEMA)} CASCADE`,
    )
    await resetRegistryWithClient(admin)
  })
})

async function resetRegistryWithClient(
  admin: import("pg").Client,
): Promise<void> {
  await admin.query("TRUNCATE microjbase.exposure_registry")
  await admin.query(
    "UPDATE microjbase.exposure_registry_state SET initialized = FALSE, imported_at = NULL",
  )
}

describe("clean install", () => {
  it("initializes empty when MICROJBASE_TABLES is unset", async () => {
    await resetRegistry()
    const state = await importInitialExposure({ query: runtimeQueryFn }, [])
    expect(state.initialized).toBe(true)
    expect(state.exposed).toEqual([])
  })

  it("imports configured mappings on first startup", async () => {
    await resetRegistry()
    const state = await importInitialExposure({ query: runtimeQueryFn }, [
      { alias: "todos", schema: APP_SCHEMA, table: "todos" },
      { alias: "notes", schema: APP_SCHEMA, table: "notes" },
    ])
    expect(state.exposed).toEqual([
      { alias: "notes", schema: APP_SCHEMA, table: "notes" },
      { alias: "todos", schema: APP_SCHEMA, table: "todos" },
    ])
    expect(state.importedAt).toBeInstanceOf(Date)
  })

  it("builds the verified runtime registry from the durable state", async () => {
    await resetRegistry()
    await importInitialExposure({ query: runtimeQueryFn }, [
      { alias: "todos", schema: APP_SCHEMA, table: "todos" },
    ])
    const state = await readExposureRegistryState({ query: runtimeQueryFn })
    const registry = await buildTableRegistry(
      { mappings: state.exposed },
      { query: runtimeQueryFn },
    )
    const todos = registry.get("todos")
    expect(todos?.schema).toBe(APP_SCHEMA)
    expect(todos?.table).toBe("todos")
    expect(todos?.readableColumns).toContain("id")
    expect(registry.get("notes")).toBeNull()
  })

  it("keeps the registry uninitialized when pre-import validation fails", async () => {
    await resetRegistry()
    // The composition root validates the configured mappings through the
    // verified registry builder BEFORE the one-time import commits (mirrors
    // the main.ts startup order).
    await expect(
      buildTableRegistry(
        {
          mappings: [
            { alias: "missing", schema: APP_SCHEMA, table: "missing" },
          ],
        },
        { query: runtimeQueryFn },
      ),
    ).rejects.toThrow(/does not exist/)
    const state = await readExposureRegistryState({ query: runtimeQueryFn })
    expect(state.initialized).toBe(false)
    expect(state.exposed).toEqual([])
  })

  it("records an unexposable mapping whose verification fails at registry build", async () => {
    await resetRegistry()
    // The import itself faithfully records what the operator configured;
    // verification stays authoritative at the registry-build step.
    const state = await importInitialExposure({ query: runtimeQueryFn }, [
      { alias: "missing", schema: APP_SCHEMA, table: "missing" },
    ])
    expect(state.initialized).toBe(true)
    await expect(
      buildTableRegistry(
        { mappings: state.exposed },
        { query: runtimeQueryFn },
      ),
    ).rejects.toThrow(/does not exist/)
    await resetRegistry()
  })
})

describe("one-time import semantics", () => {
  it("refuses a second import after initialization", async () => {
    await resetRegistry()
    await importInitialExposure({ query: runtimeQueryFn }, [
      { alias: "todos", schema: APP_SCHEMA, table: "todos" },
    ])
    await expect(
      importInitialExposure({ query: runtimeQueryFn }, [
        { alias: "notes", schema: APP_SCHEMA, table: "notes" },
      ]),
    ).rejects.toThrow()
    const state = await readExposureRegistryState({ query: runtimeQueryFn })
    expect(state.exposed).toEqual([
      { alias: "todos", schema: APP_SCHEMA, table: "todos" },
    ])
  })

  it("environment configuration cannot re-expose an unexposed table", async () => {
    await resetRegistry()
    await importInitialExposure({ query: runtimeQueryFn }, [
      { alias: "todos", schema: APP_SCHEMA, table: "todos" },
    ])
    // Operator unexposes the table through the durable registry.
    await withClient(adminDatabaseUrl as string, async (admin) => {
      await admin.query(
        `UPDATE microjbase.exposure_registry SET exposed = FALSE WHERE alias = 'todos'`,
      )
    })
    // A later "startup" re-reads the durable state: the environment variable
    // no longer matters and the table stays unexposed.
    const state = await readExposureRegistryState({ query: runtimeQueryFn })
    expect(state.exposed).toEqual([])
    const registry = await buildTableRegistry(
      { mappings: state.exposed },
      { query: runtimeQueryFn },
    )
    expect(registry.get("todos")).toBeNull()
    // The history row is retained for audit.
    await expect(registryRows()).resolves.toEqual([
      {
        alias: "todos",
        schema_name: APP_SCHEMA,
        table_name: "todos",
        exposed: false,
      },
    ])
  })
})

describe("v0.1 upgrade path", () => {
  it("preserves existing installations through the import", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "mjb-v0210-"))
    try {
      const repoMigrations = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../../migrations",
      )
      // Apply only the v0.1 migration set (0001..0005).
      for (const file of [
        "0001_microjbase_schema.sql",
        "0002_auth_tables.sql",
        "0003_auth_token_hash_unique.sql",
        "0004_todos_table.sql",
        "0005_schema_operations.sql",
      ]) {
        await copyFile(
          path.join(repoMigrations, file),
          path.join(tempDir, file),
        )
      }
      const { migrate } = await import("../../../scripts/migrate.js")

      // A dedicated upgrade database: v0.1 migrations only, then data.
      const upgradeDb = "microjbase_v0210_upgrade_test"
      await withClient(adminDatabaseUrl as string, async (admin) => {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(upgradeDb)} WITH (FORCE)`,
        )
        await admin.query(`CREATE DATABASE ${quoteIdentifier(upgradeDb)}`)
      })
      try {
        const upgradeAdminUrl = ((): string => {
          const url = new URL(adminDatabaseUrl as string)
          url.pathname = `/${upgradeDb}`
          return url.toString()
        })()
        const upgradeRuntimeUrl = ((): string => {
          const url = new URL(databaseUrl as string)
          url.pathname = `/${upgradeDb}`
          return url.toString()
        })()

        await migrate({ databaseUrl: upgradeAdminUrl, migrationDir: tempDir })

        // v0.1 runtime: the operator grants the runtime role and configures
        // MICROJBASE_TABLES=todos=public.todos; rows already exist.
        await withClient(upgradeAdminUrl, async (admin) => {
          const runtimeRole = quoteIdentifier(
            new URL(databaseUrl as string).username,
          )
          await admin.query(`
            GRANT USAGE ON SCHEMA microjbase TO ${runtimeRole};
            GRANT SELECT ON microjbase.schema_migrations TO ${runtimeRole};
            GRANT SELECT, INSERT ON microjbase.users TO ${runtimeRole};
            GRANT SELECT, INSERT, UPDATE ON microjbase.sessions TO ${runtimeRole};
            GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO ${runtimeRole};
          `)
          await admin.query(
            `INSERT INTO microjbase.users (id, email, password_hash)
             VALUES ('11111111-2222-3333-4444-555555555555',
                     'upgrade@example.com', 'upgrade-hash')`,
          )
          await admin.query(
            `INSERT INTO public.todos (title, user_id)
             VALUES ('preserved row', '11111111-2222-3333-4444-555555555555')`,
          )
        })

        // Upgrade: apply the v0.2 migrations (including 0006) and grant the
        // new registry privileges to the runtime role.
        await migrate({ databaseUrl: upgradeAdminUrl })
        await withClient(upgradeAdminUrl, async (admin) => {
          const runtimeRole = quoteIdentifier(
            new URL(databaseUrl as string).username,
          )
          await admin.query(`
            GRANT SELECT ON microjbase.exposure_registry TO ${runtimeRole};
            GRANT SELECT ON microjbase.exposure_registry_state TO ${runtimeRole};
            GRANT EXECUTE ON FUNCTION microjbase.import_exposure_registry(JSONB) TO ${runtimeRole};
          `)
        })

        const upgradeRuntimeQuery = (
          text: string,
          values?: unknown[],
        ): Promise<import("pg").QueryResult> =>
          withClient(upgradeRuntimeUrl, (client) => client.query(text, values))

        // First startup on the upgraded database performs the import.
        const state = await importInitialExposure(
          { query: upgradeRuntimeQuery },
          [{ alias: "todos", schema: "public", table: "todos" }],
        )
        expect(state.initialized).toBe(true)
        expect(state.exposed).toEqual([
          { alias: "todos", schema: "public", table: "todos" },
        ])

        // The v0.1 data is untouched and the runtime registry verifies.
        const registry = await buildTableRegistry(
          { mappings: state.exposed },
          { query: upgradeRuntimeQuery },
        )
        expect(registry.get("todos")?.table).toBe("todos")
        await withClient(upgradeRuntimeUrl, async (runtime) => {
          await runtime.query(
            `SELECT set_config('microjbase.user_id', '11111111-2222-3333-4444-555555555555', false)`,
          )
          const result = await runtime.query(`SELECT title FROM public.todos`)
          expect(result.rows).toEqual([{ title: "preserved row" }])
        })

        // Restarting no longer consults the environment: an env change
        // cannot add tables to the upgraded installation.
        await expect(
          importInitialExposure({ query: upgradeRuntimeQuery }, [
            { alias: "evil", schema: "public", table: "todos" },
          ]),
        ).rejects.toThrow()
        const after = await readExposureRegistryState({
          query: upgradeRuntimeQuery,
        })
        expect(after.exposed).toEqual([
          { alias: "todos", schema: "public", table: "todos" },
        ])
      } finally {
        await withClient(adminDatabaseUrl as string, async (admin) => {
          await admin.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(upgradeDb)} WITH (FORCE)`,
          )
        })
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
