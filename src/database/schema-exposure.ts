// Expose/unexpose service for microJBase v0.2 (V02-13, D-011, D-018).
//
// The service is the operator-facing layer that moves tables in and out of
// the data API. It extends the typed command pattern of the earlier waves:
// replay-first idempotency, catalogue preflight, compilation only through
// the sealed V02-06 compiler, and execution through the D-025/D-017
// executor, so every exposure change is serialized, recorded with a
// checksum, and commits or rolls back atomically with its grants.
// Wave-4-specific invariants:
//
// - Exposure verification fails closed: a table becomes exposed only when
//   it has the managed single-column UUID "id" primary key, supported
//   columns, ENABLE plus FORCE ROW LEVEL SECURITY, at least one RLS policy
//   applicable to the runtime role, and a non-empty readable/insertable/
//   updatable column contract for the runtime role. Internal targets are
//   refused before SQL exists.
// - Expose applies least-privilege grants as the schema-admin role: USAGE
//   on the schema, DELETE at table level, and column-level SELECT/INSERT/
//   UPDATE matching the verified contract. Unexpose revokes exactly those
//   privileges (table-level REVOKE also removes the column-level grants)
//   and never touches schema USAGE, which sibling tables may still need.
//   A missing ownership or privilege fails closed inside the transaction
//   and rolls back the registry change with it.
// - The durable registry row and the grants commit in one transaction; the
//   in-memory runtime registry is rebuilt and atomically swapped only after
//   the commit, so concurrent CRUD requests observe either the complete old
//   or the complete new exposure snapshot.
//
// No HTTP mapping exists yet; the V02-18 admin API will call these commands
// with operator authentication and idempotency keys.

import type pg from "pg"

import type {
  JsonValue,
  SchemaCatalogue,
  SchemaCatalogueReader,
  SchemaCatalogueTable,
} from "../contracts/index.js"
import { AppError } from "../core/index.js"

import {
  findExposureByAlias,
  findExposureByTarget,
  type ExposureRegistryRow,
} from "./exposure-registry.js"
import type { Pool } from "./pool.js"
import {
  compileGrantRuntimePrivileges,
  compileMarkExposed,
  compileMarkUnexposed,
  compileRevokeRuntimePrivileges,
  type ExecuteOptions,
  type ExecuteOutcome,
  type SchemaDdlExecutor,
} from "./schema-ddl.js"
import { createSchemaOperationLog } from "./schema-operation-log.js"
import { classifySchemaObject } from "./schema-snapshot.js"
import { isSupportedType, normalizeType } from "./table-types.js"

export interface ExposureCommandBase {
  /** D-025 idempotency key; replay/conflict semantics enforced by the log. */
  readonly idempotencyKey: string
  /** Operator actor label; only its HMAC fingerprint is persisted. */
  readonly actor: string
  /** Compile and preflight, then roll everything back; no history is written. */
  readonly dryRun?: boolean
}

export interface ExposeTableCommand extends ExposureCommandBase {
  readonly schema: string
  readonly table: string
  readonly alias: string
}

export interface UnexposeTableCommand extends ExposureCommandBase {
  readonly schema: string
  readonly table: string
}

/** The verified column contract granted to the runtime role on expose. */
export interface ExposureVerification {
  readonly readableColumns: readonly string[]
  readonly insertableColumns: readonly string[]
  readonly updatableColumns: readonly string[]
}

export interface SchemaExposureService {
  expose(input: ExposeTableCommand): Promise<ExecuteOutcome>
  unexpose(input: UnexposeTableCommand): Promise<ExecuteOutcome>
}

export interface SchemaExposureServiceDependencies {
  /** Admin-lane pool for preflight reads and verification. */
  readonly pool: Pool
  /** Read-only catalogue used for preflight guards. */
  readonly catalogue: SchemaCatalogueReader
  /** Sealed-plan executor from the V02-06 substrate. */
  readonly executor: SchemaDdlExecutor
  /** The schema-admin role name; exposed tables must be owned by it. */
  readonly adminRole: string
  /** The restricted runtime role receiving least-privilege grants. */
  readonly runtimeRole: string
  /**
   * Rebuild the verified runtime registry from the durable registry and
   * atomically swap it. Injected by the composition root so the admin lane
   * never holds the runtime connection surface (D-011); invoked only after
   * the exposure transaction has committed.
   */
  readonly refreshRuntimeRegistry: () => Promise<void>
  readonly logger?: Pick<Console, "error" | "warn" | "info" | "debug">
}

function validation(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, 400)
}

function conflict(message: string): AppError {
  return new AppError("CONFLICT", message, 409)
}

const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

type Query = <R extends pg.QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<pg.QueryResult<R>>

// ---------------------------------------------------------------------------
// Exposure verification. These checks run on the admin lane but interrogate
// the privileges of the runtime role, because exposure is a statement about
// what the restricted runtime lane can do. The queries mirror the v0.1
// startup verification with the role made explicit.
// ---------------------------------------------------------------------------

interface ExistsRow {
  exists: boolean
}

interface RlsRow {
  relrowsecurity: boolean
  relforcerowsecurity: boolean
}

interface PolicyRow {
  applicable: boolean
}

const TABLE_EXISTS_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
) AS exists`

const TABLE_RLS_SQL = `SELECT c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`

const POLICY_APPLICABLE_SQL = `SELECT EXISTS (
  SELECT 1
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2
  AND (
    pol.polroles = ARRAY[0]::oid[]
    OR EXISTS (
      SELECT 1 FROM unnest(pol.polroles) AS policy_role
      WHERE pg_has_role($3, policy_role, 'MEMBER')
    )
  )
) AS applicable`

const PRIMARY_KEY_SQL = `SELECT a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS data_type
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
  WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`

const COLUMNS_SQL = `SELECT a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       a.attgenerated,
       a.attidentity
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2
    AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`

/**
 * Verify that a table satisfies every exposure requirement and compute the
 * least-privilege column contract the expose grants will apply. Throws a
 * safe VALIDATION_ERROR on the first violation.
 *
 * The contract is computed from the catalogue shape, not from the runtime
 * role's current privileges: expose itself applies the grants (USAGE on
 * the schema, DELETE at table level, and the column-level SELECT/INSERT/
 * UPDATE computed here), so privilege state is the OUTPUT of a successful
 * exposure, not a precondition. The authoritative assertion that the
 * grants took effect is the post-commit runtime registry rebuild, which
 * runs the verified v0.1 builder as the runtime role before the new
 * snapshot is served.
 */
export async function verifyExposureCandidate(
  query: Query,
  runtimeRole: string,
  schema: string,
  table: string,
): Promise<ExposureVerification> {
  const qualified = `${schema}.${table}`

  const existsResult = await query<ExistsRow>(TABLE_EXISTS_SQL, [schema, table])
  if (existsResult.rows[0]?.exists !== true) {
    throw validation(`Table ${qualified} does not exist`)
  }

  const rlsResult = await query<RlsRow>(TABLE_RLS_SQL, [schema, table])
  const rlsRow = rlsResult.rows[0]
  if (rlsRow === undefined) {
    throw validation(`Table ${qualified} does not exist`)
  }
  if (!rlsRow.relrowsecurity) {
    throw validation(`Row-level security is not enabled on ${qualified}`)
  }
  if (!rlsRow.relforcerowsecurity) {
    throw validation(`Forced row-level security is not enabled on ${qualified}`)
  }

  const policyResult = await query<PolicyRow>(POLICY_APPLICABLE_SQL, [
    schema,
    table,
    runtimeRole,
  ])
  if (policyResult.rows[0]?.applicable !== true) {
    throw validation(
      `No row-level security policies on ${qualified} apply to the runtime role`,
    )
  }

  const pkResult = await query<{ column_name: string; data_type: string }>(
    PRIMARY_KEY_SQL,
    [schema, table],
  )
  if (pkResult.rows.length !== 1) {
    throw validation(`Table ${qualified} has no single-column primary key`)
  }
  const pkColumn = pkResult.rows[0]
  if (pkColumn === undefined || pkColumn.column_name !== "id") {
    throw validation(`Primary key on ${qualified} must be named "id"`)
  }
  if (normalizeType(pkColumn.data_type) !== "uuid") {
    throw validation(`Primary key "id" on ${qualified} must be type uuid`)
  }

  const columnsResult = await query<{
    column_name: string
    data_type: string
    attgenerated: string
    attidentity: string
  }>(COLUMNS_SQL, [schema, table])
  const readableColumns: string[] = []
  const insertableColumns: string[] = []
  const updatableColumns: string[] = []
  for (const row of columnsResult.rows) {
    const generated = row.attgenerated !== ""
    const identity = row.attidentity !== ""
    if (isSupportedType(row.data_type)) {
      readableColumns.push(row.column_name)
    }
    if (!generated && !identity) {
      insertableColumns.push(row.column_name)
    }
    if (row.column_name !== "id" && !generated && !identity) {
      updatableColumns.push(row.column_name)
    }
  }
  if (readableColumns.length === 0) {
    throw validation(`Table ${qualified} has no readable columns`)
  }
  if (insertableColumns.length === 0) {
    throw validation(`Table ${qualified} has no insertable columns`)
  }
  if (updatableColumns.length === 0) {
    throw validation(`Table ${qualified} has no updatable columns`)
  }

  return Object.freeze({
    readableColumns: Object.freeze(readableColumns),
    insertableColumns: Object.freeze(insertableColumns),
    updatableColumns: Object.freeze(updatableColumns),
  })
}

// ---------------------------------------------------------------------------
// Startup probe. The migration cannot grant on the registry tables to a
// role it does not know, so the operator grants out of band; the composition
// root probes here and fails startup with an operator-facing message rather
// than letting the first expose die mid-flight.
// ---------------------------------------------------------------------------

const REQUIRED_EXPOSURE_REGISTRY_PRIVILEGES: readonly {
  kind: "table" | "sequence"
  name: string
  privilege: "SELECT" | "INSERT" | "UPDATE" | "USAGE"
}[] = [
  { kind: "table", name: "microjbase.exposure_registry", privilege: "SELECT" },
  { kind: "table", name: "microjbase.exposure_registry", privilege: "INSERT" },
  { kind: "table", name: "microjbase.exposure_registry", privilege: "UPDATE" },
  {
    kind: "table",
    name: "microjbase.exposure_registry_state",
    privilege: "SELECT",
  },
  {
    kind: "sequence",
    name: "microjbase.exposure_registry_id_seq",
    privilege: "USAGE",
  },
]

export async function checkExposureRegistryWriteAccess(
  client: pg.Client | pg.PoolClient,
): Promise<void> {
  for (const required of REQUIRED_EXPOSURE_REGISTRY_PRIVILEGES) {
    const functionName =
      required.kind === "table"
        ? "has_table_privilege"
        : "has_sequence_privilege"
    const result = await client.query<{ has: boolean }>(
      `SELECT ${functionName}(current_user, $1, $2) AS has`,
      [required.name, required.privilege],
    )
    const row = result.rows[0]
    if (row === undefined || !row.has) {
      throw new AppError(
        "DATABASE_UNAVAILABLE",
        `Schema-admin database role is missing required privilege ${required.privilege} on ${required.name}`,
        503,
        { object: required.name, privilege: required.privilege },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// The command service.
// ---------------------------------------------------------------------------

export function createSchemaExposureService(
  deps: SchemaExposureServiceDependencies,
): SchemaExposureService {
  const query: Query = (text, values) => deps.pool.query(text, values)
  const operationLog = createSchemaOperationLog({ query })

  async function hasExistingRecord(idempotencyKey: string): Promise<boolean> {
    return (await operationLog.get(idempotencyKey)) !== null
  }

  async function readCatalogue(): Promise<SchemaCatalogue> {
    return deps.catalogue.read()
  }

  async function requireOwnedTable(
    catalogue: SchemaCatalogue,
    schema: string,
    table: string,
  ): Promise<SchemaCatalogueTable> {
    if (classifySchemaObject(schema.toLowerCase()) !== "operator") {
      throw validation("Internal schemas cannot be exposed")
    }
    const schemaObject = catalogue.schemas.find(
      (entry) => entry.name === schema,
    )
    if (schemaObject === undefined) {
      throw validation(`Schema ${schema} does not exist`)
    }
    const found = schemaObject.tables.find((entry) => entry.name === table)
    if (found === undefined) {
      throw validation(`Table ${schema}.${table} does not exist`)
    }
    if (found.owner !== deps.adminRole) {
      throw validation(
        "Only tables owned by the schema-admin role can be exposed",
      )
    }
    return found
  }

  function execute(
    plan: Parameters<SchemaDdlExecutor["execute"]>[0],
    options: {
      readonly idempotencyKey: string
      readonly commandType: string
      readonly command: JsonValue
      readonly actor: string
      readonly dryRun?: boolean | undefined
    },
  ): Promise<ExecuteOutcome> {
    const { dryRun, ...rest } = options
    const executeOptions: ExecuteOptions =
      dryRun === undefined ? rest : { ...rest, dryRun }
    return deps.executor.execute(plan, executeOptions)
  }

  return {
    async expose(input: ExposeTableCommand): Promise<ExecuteOutcome> {
      if (!ALIAS_PATTERN.test(input.alias)) {
        throw validation(
          `Alias "${input.alias}" must match ${ALIAS_PATTERN.source}`,
        )
      }
      if (!(await hasExistingRecord(input.idempotencyKey))) {
        const byTarget: ExposureRegistryRow | null = await findExposureByTarget(
          { query },
          input.schema,
          input.table,
        )
        if (byTarget?.exposed === true) {
          throw conflict(
            `Table ${input.schema}.${input.table} is already exposed`,
          )
        }
        const byAlias: ExposureRegistryRow | null = await findExposureByAlias(
          { query },
          input.alias,
        )
        if (
          byAlias !== null &&
          (byAlias.schema !== input.schema || byAlias.table !== input.table)
        ) {
          throw conflict(
            `Alias "${input.alias}" is already used by ${byAlias.schema}.${byAlias.table}`,
          )
        }
        const catalogue = await readCatalogue()
        await requireOwnedTable(catalogue, input.schema, input.table)
      }

      // Compilation (new and replayed keys alike) re-derives the grant
      // column lists from the live catalogue so the recorded statement list
      // and checksum can always be reconstructed for comparison; D-027
      // replay-first semantics then classify the begin outcome.
      const verification = await verifyExposureCandidate(
        query,
        deps.runtimeRole,
        input.schema,
        input.table,
      )
      const grantPlan = compileGrantRuntimePrivileges({
        schema: input.schema,
        table: input.table,
        role: deps.runtimeRole,
        grantSchemaUsage: true,
        grantDelete: true,
        columnGrants: (
          [
            { privilege: "SELECT", columns: verification.readableColumns },
            { privilege: "INSERT", columns: verification.insertableColumns },
            { privilege: "UPDATE", columns: verification.updatableColumns },
          ] as const
        ).filter((grant) => grant.columns.length > 0),
      })
      const markPlan = compileMarkExposed({
        alias: input.alias,
        schema: input.schema,
        table: input.table,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        alias: input.alias,
      }
      const outcome = await execute([grantPlan, markPlan], {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.exposure.expose",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
      if (!outcome.replayed && input.dryRun !== true) {
        await deps.refreshRuntimeRegistry()
      }
      return outcome
    },

    async unexpose(input: UnexposeTableCommand): Promise<ExecuteOutcome> {
      if (!(await hasExistingRecord(input.idempotencyKey))) {
        const byTarget: ExposureRegistryRow | null = await findExposureByTarget(
          { query },
          input.schema,
          input.table,
        )
        if (byTarget === null || byTarget.exposed !== true) {
          throw conflict(`Table ${input.schema}.${input.table} is not exposed`)
        }
        const catalogue = await readCatalogue()
        await requireOwnedTable(catalogue, input.schema, input.table)
      }

      const revokePlan = compileRevokeRuntimePrivileges({
        schema: input.schema,
        table: input.table,
        role: deps.runtimeRole,
      })
      const markPlan = compileMarkUnexposed({
        schema: input.schema,
        table: input.table,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
      }
      const outcome = await execute([revokePlan, markPlan], {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.exposure.unexpose",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
      if (!outcome.replayed && input.dryRun !== true) {
        await deps.refreshRuntimeRegistry()
      }
      return outcome
    },
  }
}
