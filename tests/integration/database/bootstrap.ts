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

export async function ensureRuntimeRole(
  adminUrl: string,
  roleName: string,
  password: string,
): Promise<void> {
  await withClient(adminUrl, async (client) => {
    await client.query(
      `DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE ${roleName} WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$;`,
    )
  })
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
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA microjbase TO ${runtimeRoleName};
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA microjbase TO ${runtimeRoleName};
      ALTER DEFAULT PRIVILEGES IN SCHEMA microjbase
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRoleName};
      ALTER DEFAULT PRIVILEGES IN SCHEMA microjbase
        GRANT SELECT ON SEQUENCES TO ${runtimeRoleName};
      GRANT CREATE ON SCHEMA public TO ${runtimeRoleName};
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
