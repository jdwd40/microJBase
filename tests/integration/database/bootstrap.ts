// Shared bootstrap helpers for database integration tests.
//
// These helpers are intentionally low-level and use the privileged admin URL
// so each suite can prepare and tear down its own isolated database.

import pg from "pg"

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
    await client.query(`
      GRANT USAGE ON SCHEMA microjbase TO ${runtimeRoleName};
      GRANT SELECT ON microjbase.schema_migrations TO ${runtimeRoleName};
      GRANT SELECT, INSERT ON microjbase.users TO ${runtimeRoleName};
      GRANT SELECT, INSERT, UPDATE ON microjbase.sessions TO ${runtimeRoleName};
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
