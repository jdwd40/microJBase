// Shared E2E configuration for the microJBase v0.1 acceptance suite.
//
// Everything here is test-only: a dedicated E2E database and a dedicated
// E2E runtime role, fully disjoint from the integration suite's
// `microjbase_integration_test` database and `microjbase_runtime` role.
//
// Required environment:
//   E2E_ADMIN_DATABASE_URL — privileged URL for a maintenance database
//   (e.g. postgres://<admin>:<pass>@127.0.0.1:5432/postgres). Used to
//   create/drop the E2E database, ensure the E2E runtime role, apply
//   migrations, and verify state out-of-band.

import { createHash } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HELPERS_DIR, "..", "..", "..")

export const E2E_DATABASE_NAME = "microjbase_e2e"
export const E2E_RUNTIME_ROLE = "microjbase_e2e_runtime"
export const E2E_RUNTIME_PASSWORD = "microjbase_e2e_runtime_password"
export const E2E_SCHEMA_ADMIN_ROLE = "microjbase_e2e_schema_admin"
export const E2E_SCHEMA_ADMIN_PASSWORD = "microjbase_e2e_schema_admin_password"
// The single operator token for the admin lane (D-013). Test-only; the
// server only ever receives its SHA-256 digest through configuration.
export const E2E_ADMIN_TOKEN = "microjbase_e2e_operator_token"
export const E2E_HOST = "127.0.0.1"
export const E2E_TABLES = "todos=public.todos"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name} environment variable is required for E2E tests ` +
        `(expected a privileged PostgreSQL URL for a maintenance database)`,
    )
  }
  return value
}

/** Privileged URL for the maintenance database (role management, CREATE/DROP DATABASE). */
export function adminMaintenanceUrl(): string {
  return requireEnv("E2E_ADMIN_DATABASE_URL")
}

/** Privileged URL for the E2E database itself (migrations, grants, verification queries). */
export function adminE2EDatabaseUrl(): string {
  const url = new URL(adminMaintenanceUrl())
  url.pathname = `/${E2E_DATABASE_NAME}`
  return url.toString()
}

/** URL the compiled server uses: dedicated runtime role against the E2E database. */
export function runtimeDatabaseUrl(postgresPort: number): string {
  const url = new URL(adminMaintenanceUrl())
  url.username = E2E_RUNTIME_ROLE
  url.password = E2E_RUNTIME_PASSWORD
  url.port = String(postgresPort)
  url.pathname = `/${E2E_DATABASE_NAME}`
  return url.toString()
}

/** URL the compiled server uses for the opt-in schema-admin lane (V02-16). */
export function schemaAdminDatabaseUrl(postgresPort: number): string {
  const url = new URL(adminMaintenanceUrl())
  url.username = E2E_SCHEMA_ADMIN_ROLE
  url.password = E2E_SCHEMA_ADMIN_PASSWORD
  url.port = String(postgresPort)
  url.pathname = `/${E2E_DATABASE_NAME}`
  return url.toString()
}

/** Configured MICROJBASE_ADMIN_TOKEN_SHA256 value for the E2E operator token. */
export function adminTokenDigestHex(): string {
  return createHash("sha256").update(E2E_ADMIN_TOKEN, "utf8").digest("hex")
}

/**
 * The compiled server is the acceptance target; silently testing a stale
 * build is worse than failing loudly. Refuse to run when any source file is
 * newer than the compiled entry point.
 */
export function assertBuildFresh(): void {
  const entry = path.join(REPO_ROOT, "dist", "main.js")
  if (!existsSync(entry)) {
    throw new Error(
      "dist/main.js not found; run `npm run build` before the E2E suite",
    )
  }
  const entryMtime = statSync(entry).mtimeMs
  const stale = findNewerThan(path.join(REPO_ROOT, "src"), entryMtime)
  if (stale !== null) {
    throw new Error(
      `${stale} is newer than dist/main.js; run \`npm run build\` before the E2E suite`,
    )
  }
}

function findNewerThan(dir: string, mtimeMs: number): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findNewerThan(full, mtimeMs)
      if (nested !== null) {
        return nested
      }
    } else if (entry.name.endsWith(".ts")) {
      if (statSync(full).mtimeMs > mtimeMs) {
        return full
      }
    }
  }
  return null
}
