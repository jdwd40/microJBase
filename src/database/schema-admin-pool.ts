// Schema-admin connection boundary for microJBase v0.2 (V02-04).
//
// The schema-admin lane is the third PostgreSQL privilege lane (D-011): a
// disabled-by-default pool over SCHEMA_DATABASE_URL used only by the planned
// admin/schema module. The lane must never share the restricted runtime data
// connection (enforced in core config), and the connecting role must be a
// non-superuser, non-BYPASSRLS role without role-management rights — the
// same fail-closed shape as the v0.1 runtime-role checks. Per-object ownership
// checks ("owns every table it mutates") are enforced per operation by later
// waves; this module rejects unsafe role configurations before any operation
// executes.
//
// With neither SCHEMA_DATABASE_URL nor MICROJBASE_ADMIN_TOKEN_SHA256
// configured the pool is never created (parseConfig leaves the URL null and
// the composition root skips this lane), so admin operations cannot run.

import type pg from "pg"

import { AppError } from "../core/index.js"

import { createPool, type Pool } from "./pool.js"

/**
 * The schema-admin pool stays deliberately small: the admin lane serves one
 * operator at a time and every mutation serializes on the reserved schema-DDL
 * advisory key, so a handful of connections is the ceiling.
 */
export const SCHEMA_ADMIN_MAX_CONNECTIONS = 5

export interface SchemaAdminRoleSafety {
  role: string
  isSuperuser: boolean
  hasBypassRls: boolean
  canCreateRole: boolean
}

interface RoleAttributeRow {
  rolname: string
  rolsuper: boolean
  rolbypassrls: boolean
  rolcreaterole: boolean
}

/**
 * Fail-closed capability checks for the schema-admin role. Rejects
 * superuser, BYPASSRLS, and role-management (CREATEROLE) rights before any
 * admin operation executes. Mirrors the v0.1 runtime-role check shape:
 * operator-facing message, no database internals.
 */
export async function checkSchemaAdminRoleSafety(
  client: pg.Client | pg.PoolClient,
): Promise<SchemaAdminRoleSafety> {
  const roleResult = await client.query<RoleAttributeRow>(`
    SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
    FROM pg_roles
    WHERE rolname = current_user
  `)

  const role = roleResult.rows[0]
  if (role === undefined) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Could not determine schema-admin database role",
      503,
    )
  }

  if (role.rolsuper) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Schema-admin database role must not be a superuser",
      503,
    )
  }

  if (role.rolbypassrls) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Schema-admin database role must not have BYPASSRLS",
      503,
    )
  }

  if (role.rolcreaterole) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Schema-admin database role must not have role-management rights (CREATEROLE)",
      503,
    )
  }

  return {
    role: role.rolname,
    isSuperuser: role.rolsuper,
    hasBypassRls: role.rolbypassrls,
    canCreateRole: role.rolcreaterole,
  }
}

export interface SchemaAdminPoolConfig {
  /** URL for the schema-admin lane only; never the runtime DATABASE_URL. */
  databaseUrl: string
  /** Optional logger forwarded to the bounded pool. */
  logger?: Pick<Console, "error" | "warn" | "info" | "debug">
}

/**
 * Create the bounded schema-admin pool. Callers must only invoke this when
 * the admin lane is enabled (both admin settings configured); the disabled
 * case never reaches here because the URL is null at the composition root.
 */
export function createSchemaAdminPool(config: SchemaAdminPoolConfig): Pool {
  return createPool({
    databaseUrl: config.databaseUrl,
    maxConnections: SCHEMA_ADMIN_MAX_CONNECTIONS,
    ...(config.logger !== undefined ? { logger: config.logger } : {}),
  })
}
