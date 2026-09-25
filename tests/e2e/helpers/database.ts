// Database provisioning helpers for the E2E acceptance suite.
//
// Uses only the dedicated E2E database and the dedicated E2E runtime role.
// The integration suite's database and `microjbase_runtime` role are never
// touched here — the database-failure tests may freely break and restore the
// E2E role without side effects.

import pg from "pg"

import {
  E2E_DATABASE_NAME,
  E2E_RUNTIME_PASSWORD,
  E2E_RUNTIME_ROLE,
  E2E_SCHEMA_ADMIN_PASSWORD,
  E2E_SCHEMA_ADMIN_ROLE,
  adminE2EDatabaseUrl,
  adminMaintenanceUrl,
} from "./config.js"

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

/**
 * Ensure the dedicated E2E runtime role exists with exactly the required
 * attributes and a known password. Idempotent and self-healing: re-running
 * restores a password changed by the database-failure tests.
 */
export async function ensureRuntimeRole(): Promise<void> {
  await withClient(adminMaintenanceUrl(), async (client) => {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${E2E_RUNTIME_ROLE}') THEN
          CREATE ROLE ${E2E_RUNTIME_ROLE} LOGIN;
        END IF;
      END
      $$;
    `)
    await client.query(`
      ALTER ROLE ${E2E_RUNTIME_ROLE}
        WITH LOGIN NOSUPERUSER NOBYPASSRLS
        PASSWORD '${E2E_RUNTIME_PASSWORD}';
    `)
  })
}

/**
 * Ensure the dedicated E2E schema-admin role exists with exactly the
 * attributes the fail-closed capability check requires (D-024): a
 * non-superuser, non-BYPASSRLS role without role-management rights. The
 * out-of-band history/registry grants mirror the operator procedure
 * documented for migrations 0005/0006 (D-025/D-028).
 */
export async function ensureSchemaAdminRole(): Promise<void> {
  await withClient(adminMaintenanceUrl(), async (client) => {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${E2E_SCHEMA_ADMIN_ROLE}') THEN
          CREATE ROLE ${E2E_SCHEMA_ADMIN_ROLE} LOGIN;
        END IF;
      END
      $$;
    `)
    await client.query(`
      ALTER ROLE ${E2E_SCHEMA_ADMIN_ROLE}
        WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE
        PASSWORD '${E2E_SCHEMA_ADMIN_PASSWORD}';
    `)
  })
}

/**
 * Grant the schema-admin role the out-of-band admin-lane privileges and
 * create its dedicated operator schema. The schema is owned by the admin
 * role so create/alter commands leave ownership there (D-011), and the
 * migration-history read is what the deterministic snapshot (V02-03) reads
 * through the admin lane.
 */
export async function grantSchemaAdminPrivileges(): Promise<void> {
  await withClient(adminE2EDatabaseUrl(), async (client) => {
    await client.query(`
      GRANT USAGE ON SCHEMA microjbase TO ${E2E_SCHEMA_ADMIN_ROLE};
      GRANT SELECT ON microjbase.schema_migrations TO ${E2E_SCHEMA_ADMIN_ROLE};
      GRANT SELECT, INSERT, UPDATE ON microjbase.schema_operations TO ${E2E_SCHEMA_ADMIN_ROLE};
      GRANT USAGE ON SEQUENCE microjbase.schema_operations_id_seq TO ${E2E_SCHEMA_ADMIN_ROLE};
      GRANT SELECT, INSERT, UPDATE ON microjbase.exposure_registry TO ${E2E_SCHEMA_ADMIN_ROLE};
      GRANT USAGE ON SEQUENCE microjbase.exposure_registry_id_seq TO ${E2E_SCHEMA_ADMIN_ROLE};
      GRANT SELECT ON microjbase.exposure_registry_state TO ${E2E_SCHEMA_ADMIN_ROLE};
      CREATE SCHEMA IF NOT EXISTS e2e_admin AUTHORIZATION ${E2E_SCHEMA_ADMIN_ROLE};
    `)
  })
}

/** Drop and recreate a clean E2E database. */
export async function resetDatabase(): Promise<void> {
  await withClient(adminMaintenanceUrl(), async (client) => {
    await client.query(
      `DROP DATABASE IF EXISTS ${E2E_DATABASE_NAME} WITH (FORCE);`,
    )
    await client.query(`CREATE DATABASE ${E2E_DATABASE_NAME};`)
  })
}

export async function dropDatabase(): Promise<void> {
  await withClient(adminMaintenanceUrl(), async (client) => {
    await client.query(
      `DROP DATABASE IF EXISTS ${E2E_DATABASE_NAME} WITH (FORCE);`,
    )
  })
}

/** Apply the real forward-only migrations using the privileged admin role. */
export async function applyMigrations(): Promise<void> {
  const { migrate } = await import("../../../scripts/migrate.js")
  await migrate({ databaseUrl: adminE2EDatabaseUrl() })
}

/** Grant the E2E runtime role exactly the privileges the API needs. */
export async function grantRuntimePrivileges(): Promise<void> {
  await withClient(adminE2EDatabaseUrl(), async (client) => {
    await client.query(`
      GRANT USAGE ON SCHEMA microjbase TO ${E2E_RUNTIME_ROLE};
      GRANT SELECT ON microjbase.schema_migrations TO ${E2E_RUNTIME_ROLE};
      GRANT SELECT, INSERT ON microjbase.users TO ${E2E_RUNTIME_ROLE};
      GRANT SELECT, INSERT, UPDATE ON microjbase.sessions TO ${E2E_RUNTIME_ROLE};
      GRANT SELECT ON microjbase.exposure_registry TO ${E2E_RUNTIME_ROLE};
      GRANT SELECT ON microjbase.exposure_registry_state TO ${E2E_RUNTIME_ROLE};
      GRANT EXECUTE ON FUNCTION microjbase.import_exposure_registry(JSONB) TO ${E2E_RUNTIME_ROLE};
      GRANT USAGE ON SCHEMA public TO ${E2E_RUNTIME_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO ${E2E_RUNTIME_ROLE};
    `)
  })
}

/** Run a query against the E2E database with privileged admin credentials. */
export async function adminQuery<
  R extends pg.QueryResultRow = pg.QueryResultRow,
>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
  return withClient(adminE2EDatabaseUrl(), (client) =>
    client.query<R>(text, values),
  )
}

/** Full per-test-file lifecycle: fresh DB, real migrations, runtime grants. */
export async function provisionDatabase(): Promise<void> {
  await ensureRuntimeRole()
  await ensureSchemaAdminRole()
  await resetDatabase()
  await applyMigrations()
  await grantRuntimePrivileges()
  await grantSchemaAdminPrivileges()
}
