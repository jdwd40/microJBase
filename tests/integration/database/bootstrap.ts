// Shared bootstrap helpers for database integration tests.
//
// These helpers are intentionally low-level and use the privileged admin URL
// so each suite can prepare and tear down its own isolated database.

import pg from "pg"

import { quoteIdentifier } from "./helpers.js"

export async function withClient<T>(
  databaseUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

export async function applyMigrationsAndGrants(
  adminUrl: string,
  runtimeRoleName: string,
): Promise<void> {
  const { migrate } = await import("../../../scripts/migrate.js")
  await migrate({ databaseUrl: adminUrl })

  await withClient(adminUrl, async (client) => {
    const role = quoteIdentifier(runtimeRoleName)
    await client.query(`
      GRANT USAGE ON SCHEMA microjbase TO ${role};
      GRANT SELECT ON microjbase.schema_migrations TO ${role};
      GRANT SELECT, INSERT ON microjbase.users TO ${role};
      GRANT SELECT, INSERT, UPDATE ON microjbase.sessions TO ${role};
      GRANT SELECT ON microjbase.exposure_registry TO ${role};
      GRANT SELECT ON microjbase.exposure_registry_state TO ${role};
      GRANT EXECUTE ON FUNCTION microjbase.import_exposure_registry(JSONB) TO ${role};
    `)
  })
}

export async function cleanMigrations(databaseUrl: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query(`
      DROP TABLE IF EXISTS microjbase.schema_migrations CASCADE;
      DROP TABLE IF EXISTS microjbase.sessions CASCADE;
      DROP TABLE IF EXISTS microjbase.users CASCADE;
      DROP SCHEMA IF EXISTS microjbase CASCADE;
    `)
  })
}
