// Schema-admin connection boundary for microJBase v0.2 (V02-04).
//
// The schema-admin lane is the third PostgreSQL privilege lane (D-011): a
// disabled-by-default pool over SCHEMA_DATABASE_URL used only by the planned
// admin/schema module. The lane must never share the restricted runtime data
// connection — enforced twice: parseConfig compares the normalized URL
// surfaces, and startup compares the live session identities (role,
// database, server address, and port read from both sessions). The
// connecting role must be a non-superuser, non-BYPASSRLS role without
// role-management rights — the same fail-closed shape as the v0.1
// runtime-role checks. Membership in the inherited server-wide privilege
// groups (pg_execute_server_program, pg_write_server_files,
// pg_read_all_data, pg_write_all_data) and the CREATEDB attribute are
// rejected too: none are reachable through the current_user attribute flags
// alone, and any of them would let the lane escape its least-privilege box.
// Per-object ownership checks ("owns every table it mutates") are enforced
// per operation by later waves; this module rejects unsafe role
// configurations before any operation executes.
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

// Inherited server-wide privilege groups the schema-admin role must never
// hold. Each grants a broad capability (server program execution, server file
// writes, or cluster-wide data access) that no schema-management lane needs.
const FORBIDDEN_ROLE_MEMBERSHIPS: readonly {
  role: string
  capability: string
}[] = [
  {
    role: "pg_execute_server_program",
    capability: "execute programs on the database server",
  },
  { role: "pg_write_server_files", capability: "write server files" },
  { role: "pg_read_all_data", capability: "read all data" },
  { role: "pg_write_all_data", capability: "write all data" },
]

export interface SchemaAdminRoleSafety {
  role: string
  isSuperuser: boolean
  hasBypassRls: boolean
  canCreateRole: boolean
  canCreateDatabase: boolean
  dangerousMemberships: readonly string[]
}

interface RoleAttributeRow {
  rolname: string
  rolsuper: boolean
  rolbypassrls: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  member_pg_execute_server_program: boolean
  member_pg_write_server_files: boolean
  member_pg_read_all_data: boolean
  member_pg_write_all_data: boolean
}

/**
 * Fail-closed capability checks for the schema-admin role. Rejects
 * superuser, BYPASSRLS, role-management (CREATEROLE), CREATEDB, and
 * membership in the inherited server-wide privilege groups before any admin
 * operation executes. Mirrors the v0.1 runtime-role check shape:
 * operator-facing message, no database internals.
 */
export async function checkSchemaAdminRoleSafety(
  client: pg.Client | pg.PoolClient,
): Promise<SchemaAdminRoleSafety> {
  const membershipSelects = FORBIDDEN_ROLE_MEMBERSHIPS.map(
    (membership) =>
      `pg_has_role(current_user, '${membership.role}', 'MEMBER') AS member_${membership.role}`,
  ).join(",\n       ")
  const roleResult = await client.query<RoleAttributeRow>(`
    SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
       ${membershipSelects}
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

  if (role.rolcreatedb) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Schema-admin database role must not have CREATEDB",
      503,
    )
  }

  const dangerousMemberships = FORBIDDEN_ROLE_MEMBERSHIPS.filter(
    (membership) =>
      role[`member_${membership.role}` as keyof RoleAttributeRow] === true,
  ).map((membership) => membership.role)
  if (dangerousMemberships.length > 0) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      `Schema-admin database role must not be a member of ${dangerousMemberships.join(", ")}`,
      503,
    )
  }

  return {
    role: role.rolname,
    isSuperuser: role.rolsuper,
    hasBypassRls: role.rolbypassrls,
    canCreateRole: role.rolcreaterole,
    canCreateDatabase: role.rolcreatedb,
    dangerousMemberships,
  }
}

interface SessionIdentityRow {
  user: string
  database: string
  server_addr: string | null
  server_port: number | null
}

/**
 * Compare the live runtime and schema-admin sessions: same role, database,
 * and server endpoint means the two URLs are spelling variants of one
 * connection surface (D-011), regardless of how the URLs differ textually.
 * Aborts startup with an operator-facing error.
 */
export async function assertSchemaAdminSessionDistinct(
  runtimeClient: pg.Client | pg.PoolClient,
  adminClient: pg.Client | pg.PoolClient,
): Promise<void> {
  const identitySql = `
    SELECT current_user AS user,
           current_database() AS database,
           inet_server_addr()::text AS server_addr,
           inet_server_port() AS server_port
  `
  const [runtimeResult, adminResult] = await Promise.all([
    runtimeClient.query<SessionIdentityRow>(identitySql),
    adminClient.query<SessionIdentityRow>(identitySql),
  ])
  const runtime = runtimeResult.rows[0]
  const admin = adminResult.rows[0]
  if (runtime === undefined || admin === undefined) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Could not determine database session identity for the schema-admin lane",
      503,
    )
  }
  const sameIdentity =
    runtime.user === admin.user &&
    runtime.database === admin.database &&
    runtime.server_addr === admin.server_addr &&
    runtime.server_port === admin.server_port
  if (sameIdentity) {
    throw new AppError(
      "VALIDATION_ERROR",
      "SCHEMA_DATABASE_URL connects with the same database role and database as DATABASE_URL; the schema-admin lane must stay distinct from the runtime lane (D-011)",
      400,
    )
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
