import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { migrate } from "../../../scripts/migrate.js"
import { cleanMigrations, withClient } from "./bootstrap.js"

const databaseUrl = process.env.MIGRATION_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "MIGRATION_DATABASE_URL environment variable is required for migration tests",
  )
}

describe("migration runner", () => {
  beforeEach(async () => {
    await cleanMigrations(databaseUrl)
  })

  afterEach(async () => {
    await cleanMigrations(databaseUrl)
  })

  it("applies all migrations on a clean database", async () => {
    await migrate({ databaseUrl })
    await withClient(databaseUrl, async (client) => {
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
      const realMigrationDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "migrations",
      )
      writeFileSync(
        path.join(tempDir, "0001_microjbase_schema.sql"),
        readFileSync(
          path.join(realMigrationDir, "0001_microjbase_schema.sql"),
          "utf8",
        ),
      )
      writeFileSync(
        path.join(tempDir, "0002_auth_tables.sql"),
        "SELECT 1; -- tampered",
      )

      await expect(
        migrate({ databaseUrl, migrationDir: tempDir }),
      ).rejects.toThrow(
        /Checksum mismatch for applied migration 0002_auth_tables.sql/,
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("rolls back a failing migration", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mjbase-migrate-"))
    try {
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

      await withClient(databaseUrl, async (client) => {
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
    await Promise.all([migrate({ databaseUrl }), migrate({ databaseUrl })])

    await withClient(databaseUrl, async (client) => {
      const result = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM microjbase.schema_migrations",
      )
      expect(result.rows[0]?.count).toBeGreaterThanOrEqual(2)
    })
  })

  it("does not execute main when imported as a module", async () => {
    const beforeExitCode = process.exitCode
    const originalArgv1 = process.argv[1] ?? ""
    try {
      process.argv[1] = "not-the-migrate-script"
      const module = await import("../../../scripts/migrate.js")
      expect(module).toBeDefined()
      expect(process.exitCode).toBeUndefined()
    } finally {
      process.argv[1] = originalArgv1
      process.exitCode = beforeExitCode
    }
  })
})
