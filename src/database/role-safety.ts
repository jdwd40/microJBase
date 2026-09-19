// Runtime database-role safety checks for microJBase v0.1.
//
// The API must refuse to start if the configured DATABASE_URL connects as a
// role that is a superuser, has BYPASSRLS, or owns exposed tables without
// forced RLS. These checks fail closed.

import type pg from "pg"

import { AppError } from "../core/index.js"

export interface RoleSafetyResult {
  role: string
  isSuperuser: boolean
  hasBypassRls: boolean
}

export interface TableOwnershipCheck {
  schema: string
  table: string
  owner: string
  hasRls: boolean
  hasForceRls: boolean
}

export interface RuntimeRoleSafety {
  role: string
  isSuperuser: boolean
  hasBypassRls: boolean
  tables: readonly TableOwnershipCheck[]
}

export async function checkRuntimeRoleSafety(
  client: pg.Client | pg.PoolClient,
): Promise<RuntimeRoleSafety> {
  const roleResult = await client.query<{
    rolname: string
    rolsuper: boolean
    rolbypassrls: boolean
  }>(`
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `)

  if (roleResult.rows.length === 0) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Could not determine current database role",
      503,
    )
  }

  const role = roleResult.rows[0]
  if (role === undefined) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Could not determine current database role",
      503,
    )
  }

  if (role.rolsuper) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Runtime database role must not be a superuser",
      503,
    )
  }

  if (role.rolbypassrls) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Runtime database role must not have BYPASSRLS",
      503,
    )
  }

  return {
    role: role.rolname,
    isSuperuser: role.rolsuper,
    hasBypassRls: role.rolbypassrls,
    tables: [],
  }
}

export interface TablePrivilegeCheck {
  schema: string
  table: string
  hasSelect: boolean
  hasInsert: boolean
  hasUpdate: boolean
  hasDelete: boolean
}

export interface PolicyCheck {
  schema: string
  table: string
  policyName: string
  applicableRoles: readonly string[]
}

export interface RuntimeTableSafety {
  ownership: TableOwnershipCheck
  privileges: TablePrivilegeCheck
  policies: readonly PolicyCheck[]
}

export async function checkTableOwnershipAndRls(
  client: pg.Client | pg.PoolClient,
  tables: readonly { schema: string; table: string }[],
): Promise<readonly TableOwnershipCheck[]> {
  const checks: TableOwnershipCheck[] = []

  for (const { schema, table } of tables) {
    const result = await client.query<{
      relname: string
      nspname: string
      relowner: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      `
        SELECT c.relname, n.nspname, pg_get_userbyid(c.relowner) AS relowner,
               c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
      `,
      [schema, table],
    )

    if (result.rows.length === 0) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Configured table ${schema}.${table} does not exist`,
        503,
        { schema, table },
      )
    }

    const row = result.rows[0]
    if (row === undefined) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Configured table ${schema}.${table} does not exist`,
        503,
        { schema, table },
      )
    }

    const check: TableOwnershipCheck = {
      schema: row.nspname,
      table: row.relname,
      owner: row.relowner,
      hasRls: row.relrowsecurity,
      hasForceRls: row.relforcerowsecurity,
    }

    if (!row.relrowsecurity) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Row-level security is not enabled on ${schema}.${table}`,
        503,
        { schema, table },
      )
    }

    if (!row.relforcerowsecurity) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Forced row-level security is not enabled on ${schema}.${table}`,
        503,
        { schema, table },
      )
    }

    checks.push(check)
  }

  return checks
}

export async function checkRuntimeTablePrivileges(
  client: pg.Client | pg.PoolClient,
  tables: readonly { schema: string; table: string }[],
): Promise<readonly TablePrivilegeCheck[]> {
  const checks: TablePrivilegeCheck[] = []

  for (const { schema, table } of tables) {
    const result = await client.query<{
      privilege_type: string
    }>(
      `
        SELECT privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = $1 AND table_name = $2
          AND grantee = current_user
      `,
      [schema, table],
    )

    const privileges = new Set(result.rows.map((r) => r.privilege_type))
    checks.push({
      schema,
      table,
      hasSelect: privileges.has("SELECT"),
      hasInsert: privileges.has("INSERT"),
      hasUpdate: privileges.has("UPDATE"),
      hasDelete: privileges.has("DELETE"),
    })
  }

  return checks
}

export async function checkApplicablePolicies(
  client: pg.Client | pg.PoolClient,
  tables: readonly { schema: string; table: string }[],
): Promise<readonly PolicyCheck[]> {
  const checks: PolicyCheck[] = []

  for (const { schema, table } of tables) {
    const result = await client.query<{
      policyname: string
      roles: string[]
    }>(
      `
        SELECT pol.polname AS policyname,
               ARRAY(
                 SELECT pg_get_userbyid(role_member)
                 FROM unnest(pol.polroles) AS role_member
               ) AS roles
        FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
      `,
      [schema, table],
    )

    if (result.rows.length === 0) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `No row-level security policies exist for ${schema}.${table}`,
        503,
        { schema, table },
      )
    }

    for (const row of result.rows) {
      checks.push({
        schema,
        table,
        policyName: row.policyname,
        applicableRoles: row.roles,
      })
    }
  }

  return checks
}
