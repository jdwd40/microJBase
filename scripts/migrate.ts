// Migration command entry point for microJBase v0.1.
//
// Reads MIGRATION_DATABASE_URL (or DATABASE_URL as fallback) and applies any
// pending forward migrations under migrations/*.sql using an advisory lock.
// This script is intended to be run explicitly by an operator or CI, not by
// the running API process.

import { readdir, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"

const MIGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
)

const LOCK_KEY = 7_921_890_504_698_152_929n // "microjba" bit-packed as int64

interface MigrationFile {
  version: number
  description: string
  filename: string
  path: string
}

export async function migrate(options: {
  databaseUrl: string
  migrationDir?: string
  lockKey?: number | bigint
}): Promise<void> {
  const migrationDir = options.migrationDir ?? MIGRATION_DIR
  const lockKey = options.lockKey ?? LOCK_KEY

  const files = await listMigrationFiles(migrationDir)

  const client = new pg.Client({ connectionString: options.databaseUrl })
  await client.connect()

  try {
    await client.query("BEGIN")

    // Obtain a PostgreSQL advisory lock using the 64-bit key. This is the
    // migrator lock; it is automatically released when the session ends.
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      BigInt.asIntN(64, BigInt(lockKey)),
    ])

    // Ensure the migration registry exists even on a brand-new database.
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS microjbase;
      CREATE TABLE IF NOT EXISTS microjbase.schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `)

    const appliedResult = await client.query<{
      filename: string
      checksum: string
    }>(
      "SELECT filename, checksum FROM microjbase.schema_migrations ORDER BY filename",
    )
    const applied = new Map(
      appliedResult.rows.map((r) => [r.filename, r.checksum]),
    )

    for (const file of files) {
      const sql = await readFile(file.path, "utf8")
      const checksum = sha256Checksum(sql)

      const existing = applied.get(file.filename)
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(
            `Checksum mismatch for applied migration ${file.filename}: ` +
              `recorded ${existing}, current ${checksum}`,
          )
        }
        continue
      }

      await client.query(sql)
      await client.query(
        "INSERT INTO microjbase.schema_migrations (filename, checksum, applied_at) VALUES ($1, $2, now())",
        [file.filename, checksum],
      )
      console.log(`Applied migration ${file.filename}`)
    }

    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => {
      // Best-effort rollback; the original error is what matters.
    })
    throw error
  } finally {
    await client.end()
  }
}

async function listMigrationFiles(
  migrationDir: string,
): Promise<MigrationFile[]> {
  const entries = await readdir(migrationDir)
  const parsed: MigrationFile[] = []

  for (const filename of entries) {
    if (!filename.endsWith(".sql")) {
      continue
    }
    const match = /^(\d{4})_(.+)\.sql$/.exec(filename)
    if (!match) {
      throw new Error(
        `Migration filename ${filename} does not match NNNN_description.sql`,
      )
    }
    const versionStr = match[1]
    const description = match[2]
    if (versionStr === undefined || description === undefined) {
      throw new Error(`Migration filename ${filename} has an invalid format`)
    }
    const version = Number(versionStr)
    if (Number.isNaN(version)) {
      throw new Error(`Migration filename ${filename} has an invalid version`)
    }
    parsed.push({
      version,
      description,
      filename,
      path: path.join(migrationDir, filename),
    })
  }

  parsed.sort((a, b) => a.version - b.version)

  // Detect gaps and duplicates.
  for (let i = 0; i < parsed.length; i++) {
    const expectedVersion = i + 1
    const file = parsed[i]
    if (file === undefined) {
      throw new Error("Migration list contains an undefined entry")
    }
    if (file.version !== expectedVersion) {
      throw new Error(
        `Migration version gap or duplicate: expected ${String(expectedVersion).padStart(4, "0")}, found ${file.filename}`,
      )
    }
  }

  return parsed
}

function sha256Checksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function requireMigrationDatabaseUrl(): string {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL
  if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL environment variable is required")
  }
  return databaseUrl
}

async function main(): Promise<void> {
  await migrate({ databaseUrl: requireMigrationDatabaseUrl() })
}

// Only run when this module is the process entry point, never when imported.
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
