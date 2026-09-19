import { describe, expect, it, beforeEach, afterEach } from "vitest"
import pg from "pg"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"

import { migrate } from "../../../scripts/migrate.js"

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.INTEGRATION_DATABASE_URL ??
  "postgres://microjbase:microjbase_dev_password@127.0.0.1:5432/microjbase_dev"

async function withClient<T>(
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

async function cleanMigrations(): Promise<void> {
  await withClient(async (client) => {
    await client.query(`
      DROP TABLE IF EXISTS microjbase.schema_migrations CASCADE;
      DROP TABLE IF EXISTS microjbase.sessions CASCADE;
      DROP TABLE IF EXISTS microjbase.users CASCADE;
      DROP SCHEMA IF EXISTS microjbase CASCADE;
    `)
  })
}

describe("migration runner", () => {
  beforeEach(async () => {
    await cleanMigrations()
  })

  afterEach(async () => {
    await cleanMigrations()
  })

  it("applies all migrations on a clean database", async () => {
    await migrate({ databaseUrl })
    await withClient(async (client) => {
      const result = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM microjbase.schema_migrations",
      )
      expect(result.rows[0]?.count).toBeGreaterThanOrEqual(2)
    })
  })

  it("is repeatable without error", async () => {
    await migrate({ databaseUrl })
    await expect(migrate({ databaseUrl })).resolves.toBeUndefined()
  })

  it("detects checksum mismatch for applied migrations", async () => {
    await migrate({ databaseUrl })

    const tempDir = mkdtempSync(path.join(tmpdir(), "mjbase-migrate-"))
    try {
      // Provide a valid registry migration plus a tampered second migration so
      // the runner reaches an already-applied file with a different checksum.
      writeFileSync(
        path.join(tempDir, "0001_microjbase_schema.sql"),
        "CREATE SCHEMA IF NOT EXISTS microjbase;",
      )
      writeFileSync(
        path.join(tempDir, "0002_auth_tables.sql"),
        "SELECT 1; -- tampered",
      )

      await expect(
        migrate({ databaseUrl, migrationDir: tempDir }),
      ).rejects.toThrow(/Checksum mismatch/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("rolls back a failing migration", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mjbase-migrate-"))
    try {
      // 0001 is valid; 0002 will fail and should be rolled back.
      writeFileSync(
        path.join(tempDir, "0001_valid.sql"),
        "CREATE SCHEMA IF NOT EXISTS microjbase; CREATE TABLE IF NOT EXISTS microjbase.tmp_valid (id int);",
      )
      writeFileSync(
        path.join(tempDir, "0002_broken.sql"),
        "CREATE TABLE does_not_exist.invalid_syntax;;",
      )

      await expect(
        migrate({ databaseUrl, migrationDir: tempDir }),
      ).rejects.toThrow()

      await withClient(async (client) => {
        const result = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'microjbase' AND table_name = 'tmp_valid'
          ) AS exists`,
        )
        expect(result.rows[0]?.exists).toBe(false)
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("uses advisory locking so only one migrator runs", async () => {
    // We cannot easily observe the lock externally, but we can at least prove
    // two concurrent migrators complete without error and leave consistent
    // state. PostgreSQL serializes them via pg_advisory_xact_lock.
    await Promise.all([migrate({ databaseUrl }), migrate({ databaseUrl })])

    await withClient(async (client) => {
      const result = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM microjbase.schema_migrations",
      )
      expect(result.rows[0]?.count).toBeGreaterThanOrEqual(2)
    })
  })
})
