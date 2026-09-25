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
//   and rolls back the registry change with it; because a REVOKE only
//   removes grants made by the revoker, a guard statement re-reads the
//   runtime role's residual privileges inside the same transaction and
//   raises when anything still holds, so a table can never be marked
//   unexposed while the runtime role keeps a privilege on it.
// - The durable registry row and the grants commit in one transaction; the
//   in-memory runtime registry is rebuilt and atomically swapped only after
//   the commit, so concurrent CRUD requests observe either the complete old
//   or the complete new exposure snapshot.
//
// No HTTP mapping exists yet; the V02-18 admin API will call these commands
// with operator authentication and idempotency keys.

import { randomBytes } from "node:crypto"

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
import { quoteIdentifier } from "./identifier.js"
import type { Pool } from "./pool.js"
import {
  compileAssertExposurePrerequisites,
  compileGrantRuntimePrivileges,
  compileMarkExposed,
  compileMarkUnexposed,
  compileOwnershipComparison,
  compileRevokeRuntimePrivileges,
  compileVerifyRuntimePrivilegesRevoked,
  type ExecuteOptions,
  type ExecuteOutcome,
  type OwnershipPolicyTemplate,
  ownershipPolicyName,
  ownershipPolicyTemplateShape,
  type SchemaDdlExecutor,
} from "./schema-ddl.js"
import {
  createSchemaOperationLog,
  type SchemaOperationRecord,
} from "./schema-operation-log.js"
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

// Exposure verification. These checks run on the admin lane but interrogate
// the privileges of the runtime role, because exposure is a statement about
// what the restricted runtime lane can do. The queries mirror the v0.1
// startup verification with the role made explicit. Every catalogue
// reference is schema-qualified with pg_catalog: these probes run on the
// admin pool BEFORE the executor pins search_path, and an unqualified
// pg_class/has_table_privilege would resolve against a hostile first
// entry in the connection's search_path (R5 review, JDW-23), letting a
// forged catalogue pass verification.

interface ExistsRow {
  exists: boolean
}

interface RlsRow {
  relrowsecurity: boolean
  relforcerowsecurity: boolean
}

const TABLE_EXISTS_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'
) AS exists`

const TABLE_RLS_SQL = `SELECT c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`

// Every policy applicable to the runtime role, with its expressions rendered
// back through pg_get_expr. Exposure verification no longer accepts "any
// applicable policy": it requires the module-owned ownership policy for each
// command the runtime role will exercise and rejects any other permissive
// policy applicable to the role, because permissive policies OR together and
// a broader USING (true) beside the ownership policy would let one tenant
// read another tenant's rows (JDW-27).
const APPLICABLE_POLICIES_SQL = `SELECT pol.polname AS policy_name,
       pol.polcmd AS command,
       pol.polpermissive AS permissive,
       pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
       pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expression
  FROM pg_catalog.pg_policy pol
  JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2
  AND (
    pol.polroles = ARRAY[0]::oid[]
    OR EXISTS (
      SELECT 1 FROM pg_catalog.unnest(pol.polroles) AS policy_role
      WHERE pg_catalog.pg_has_role($3, policy_role, 'MEMBER')
    )
  )`

interface ApplicablePolicyRow {
  policy_name: string
  command: string
  permissive: boolean
  using_expression: string | null
  check_expression: string | null
}

// The four commands the data API exercises on an exposed table, mapped to the
// ownership template and the pg_policy.polcmd code that serves each.
const RUNTIME_EXERCISED_COMMANDS: Readonly<
  { template: OwnershipPolicyTemplate; policyCommand: string }[]
> = Object.freeze([
  { template: "read", policyCommand: "r" },
  { template: "insert", policyCommand: "a" },
  { template: "update", policyCommand: "w" },
  { template: "delete", policyCommand: "d" },
])

// The frozen ownership comparison, rendered back through PostgreSQL itself.
// Exposure verification cannot hard-code pg_get_expr's text rendering: the
// deparse of the comparison is version-dependent, and a string that only
// matches one server's rendering would fail closed on every other. Instead
// the service creates a throwaway probe policy carrying the module's frozen
// comparison inside a rolled-back transaction and returns what pg_get_expr
// renders for it on THIS server, so the requirement is exactly the
// expression the module itself compiles (JDW-27).
export interface RenderedOwnershipComparison {
  readonly using: string | null
  readonly withCheck: string | null
}

export interface OwnershipComparisonProbe {
  render(
    schema: string,
    table: string,
    column: string,
    template: OwnershipPolicyTemplate,
  ): Promise<RenderedOwnershipComparison>
}

const OWNERSHIP_TEMPLATES: readonly OwnershipPolicyTemplate[] = Object.freeze([
  "read",
  "insert",
  "update",
  "delete",
])

// The (column, template) identity a policy name claims, derived only from a
// name that reproduces the deterministic module digest, so a lookalike name
// can never validate.
function modulePolicyIdentity(
  policyName: string,
  table: string,
  columnNames: readonly string[],
): {
  readonly column: string
  readonly template: OwnershipPolicyTemplate
} | null {
  for (const column of columnNames) {
    for (const template of OWNERSHIP_TEMPLATES) {
      if (policyName === ownershipPolicyName(table, column, template)) {
        return { column, template }
      }
    }
  }
  return null
}

// Whether a policy row is the module-owned ownership policy the given
// template expects: the deterministic module name over one of the table's
// columns, the template's exact FOR command, and the frozen ownership
// expression on exactly the clause(s) that template renders (USING for
// read/update/delete, WITH CHECK for insert/update), as rendered by this
// PostgreSQL server for a probe policy carrying the module's own comparison.
async function matchesModuleOwnershipPolicy(
  row: ApplicablePolicyRow,
  table: string,
  columnNames: readonly string[],
  template: OwnershipPolicyTemplate,
  schema: string,
  probe: OwnershipComparisonProbe,
  cache: Map<string, Promise<RenderedOwnershipComparison>>,
): Promise<boolean> {
  const identity = modulePolicyIdentity(row.policy_name, table, columnNames)
  if (identity === null || identity.template !== template) {
    return false
  }
  const shape = ownershipPolicyTemplateShape(template)
  const cacheKey = `${identity.column}:${template}`
  let rendered = cache.get(cacheKey)
  if (rendered === undefined) {
    rendered = probe.render(schema, table, identity.column, template)
    cache.set(cacheKey, rendered)
  }
  const expected = await rendered
  if (shape.using && row.using_expression !== expected.using) {
    return false
  }
  if (!shape.using && row.using_expression !== null) {
    return false
  }
  if (shape.withCheck && row.check_expression !== expected.withCheck) {
    return false
  }
  if (!shape.withCheck && row.check_expression !== null) {
    return false
  }
  return true
}

const PRIMARY_KEY_SQL = `SELECT a.attname AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
  WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`

const COLUMNS_SQL = `SELECT a.attname AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
       a.attgenerated,
       a.attidentity
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
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
 *
 * The strict policy check requires an ownership-comparison probe: the
 * caller supplies one that renders the module's frozen comparison through
 * this server's own deparser, because pg_get_expr's rendering is
 * server-version-dependent and cannot be matched against a hard-coded
 * string.
 */
export async function verifyExposureCandidate(
  query: Query,
  runtimeRole: string,
  schema: string,
  table: string,
  probe: OwnershipComparisonProbe,
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
  const columnNames: string[] = []
  const readableColumns: string[] = []
  const insertableColumns: string[] = []
  const updatableColumns: string[] = []
  for (const row of columnsResult.rows) {
    columnNames.push(row.column_name)
    const generated = row.attgenerated !== ""
    const identity = row.attidentity !== ""
    // Insert/update grants are restricted to supported types exactly like
    // readable columns: a column the data contract cannot represent (for
    // example bytea) must not receive a grant the API can never honour
    // (R5 review, JDW-23).
    const supported = isSupportedType(row.data_type)
    if (supported) {
      readableColumns.push(row.column_name)
    }
    if (supported && !generated && !identity) {
      insertableColumns.push(row.column_name)
    }
    if (supported && row.column_name !== "id" && !generated && !identity) {
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

  // Strict policy check: for every command the runtime role will exercise,
  // the applicable policies must be exactly the module-owned ownership policy
  // (deterministic name plus the frozen ownership expression rendered by this
  // server). Any other permissive policy applicable to the role would OR with
  // the ownership policy and expose one tenant's rows to another, so it fails
  // closed here.
  const policiesResult = await query<ApplicablePolicyRow>(
    APPLICABLE_POLICIES_SQL,
    [schema, table, runtimeRole],
  )
  const applicablePolicies = policiesResult.rows
  const comparisonCache = new Map<
    string,
    Promise<RenderedOwnershipComparison>
  >()
  for (const { template, policyCommand } of RUNTIME_EXERCISED_COMMANDS) {
    const commandPolicies = applicablePolicies.filter(
      (row) => row.command === policyCommand || row.command === "*",
    )
    const hasModulePolicy = (
      await Promise.all(
        commandPolicies.map((row) =>
          matchesModuleOwnershipPolicy(
            row,
            table,
            columnNames,
            template,
            schema,
            probe,
            comparisonCache,
          ),
        ),
      )
    ).some(Boolean)
    if (!hasModulePolicy) {
      throw validation(
        `Table ${qualified} has no managed ${template} ownership policy applying to the runtime role`,
      )
    }
    const broader = (
      await Promise.all(
        commandPolicies.map(
          async (row) =>
            row.permissive &&
            !(await matchesModuleOwnershipPolicy(
              row,
              table,
              columnNames,
              template,
              schema,
              probe,
              comparisonCache,
            )),
        ),
      )
    ).some(Boolean)
    if (broader) {
      throw validation(
        `A row-level security policy on ${qualified} other than the managed ${template} ownership policy applies to the runtime role`,
      )
    }
  }

  return Object.freeze({
    readableColumns: Object.freeze(readableColumns),
    insertableColumns: Object.freeze(insertableColumns),
    updatableColumns: Object.freeze(updatableColumns),
  })
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  )
}

// Rebuild the verified column contract from the recorded command of an
// existing expose operation, so a replayed key compiles the byte-identical
// statement list for the checksum comparison without re-verifying against a
// catalogue that may have drifted since the recorded success (JDW-27).
function verificationFromRecord(
  record: SchemaOperationRecord,
  input: ExposeTableCommand,
): ExposureVerification {
  const command = record.command
  if (
    typeof command !== "object" ||
    command === null ||
    Array.isArray(command)
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Malformed schema operation record: command must be a JSON object",
      500,
    )
  }
  const recorded = command as Record<string, JsonValue>
  if (
    recorded["schema"] !== input.schema ||
    recorded["table"] !== input.table ||
    recorded["alias"] !== input.alias
  ) {
    throw new AppError(
      "CONFLICT",
      "Idempotency key was already used with a different operation",
      409,
      { idempotencyKey: record.idempotencyKey },
    )
  }
  const readableColumns = recorded["readableColumns"]
  const insertableColumns = recorded["insertableColumns"]
  const updatableColumns = recorded["updatableColumns"]
  if (
    !isStringArray(readableColumns) ||
    !isStringArray(insertableColumns) ||
    !isStringArray(updatableColumns)
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Malformed schema operation record: exposure command is missing the recorded column contract",
      500,
    )
  }
  return Object.freeze({
    readableColumns: Object.freeze([...readableColumns]),
    insertableColumns: Object.freeze([...insertableColumns]),
    updatableColumns: Object.freeze([...updatableColumns]),
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
        ? "pg_catalog.has_table_privilege"
        : "pg_catalog.has_sequence_privilege"
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

  // Render the module's frozen ownership comparison through this server's
  // own deparser: create a uniquely named probe policy carrying the compiled
  // comparison inside a transaction that always rolls back, and read back
  // what pg_get_expr renders for it. Because the probe is created with the
  // same compiled SQL the module's real policies use, its rendering is
  // exactly what a genuine managed policy produces on this server — version
  // differences in the deparser cannot cause a false rejection (JDW-27).
  const comparisonProbe: OwnershipComparisonProbe = {
    async render(schema, table, column, template) {
      const shape = ownershipPolicyTemplateShape(template)
      const probeName = `mjb_probe_${randomBytes(8).toString("hex")}`
      const comparison = compileOwnershipComparison(column)
      const client = await deps.pool.connect()
      try {
        await client.query("BEGIN")
        try {
          let statement =
            `CREATE POLICY ${quoteIdentifier(probeName)} ` +
            `ON ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ` +
            `FOR ${shape.command} TO ${quoteIdentifier(deps.runtimeRole)}`
          if (shape.using) {
            statement += ` USING (${comparison})`
          }
          if (shape.withCheck) {
            statement += ` WITH CHECK (${comparison})`
          }
          await client.query(statement)
          const rendered = await client.query<{
            using: string | null
            check: string | null
          }>(
            `SELECT pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using,
                    pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check
               FROM pg_catalog.pg_policy pol
               JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2 AND pol.polname = $3`,
            [schema, table, probeName],
          )
          const row = rendered.rows[0]
          if (row === undefined) {
            throw new AppError("INTERNAL_ERROR", "Schema operation failed", 500)
          }
          return { using: row.using, withCheck: row.check }
        } finally {
          await client.query("ROLLBACK").catch(() => undefined)
        }
      } finally {
        client.release()
      }
    },
  }

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
      // A brand-new key (and every dry run, which simulates against the live
      // catalogue) runs the full preflight and exposure verification. A key
      // with an existing operation record is a replay: verification is
      // skipped because the table may legitimately have drifted since the
      // recorded success, and the recorded contract rebuilds the exact
      // statement list so the D-027 checksum comparison still classifies the
      // begin outcome instead of dying in preflight (JDW-27).
      const existing =
        input.dryRun === true
          ? null
          : await operationLog.get(input.idempotencyKey)
      let verification: ExposureVerification
      if (input.dryRun === true || existing === null) {
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
        verification = await verifyExposureCandidate(
          query,
          deps.runtimeRole,
          input.schema,
          input.table,
          comparisonProbe,
        )
      } else {
        verification = verificationFromRecord(existing, input)
      }

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
      // The locked prerequisite guard runs before any GRANT or registry
      // upsert: under the advisory lock it refuses a table that is already
      // exposed (so a racing second expose conflicts instead of renaming the
      // public alias) or whose row security has drifted since verification.
      const prerequisitePlan = compileAssertExposurePrerequisites({
        schema: input.schema,
        table: input.table,
        role: deps.runtimeRole,
      })
      // The recorded command carries the verified column contract so a replay
      // can reconstruct the identical statement list for the checksum
      // comparison without re-reading the live catalogue.
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        alias: input.alias,
        readableColumns: [...verification.readableColumns],
        insertableColumns: [...verification.insertableColumns],
        updatableColumns: [...verification.updatableColumns],
      }
      const outcome = await execute([prerequisitePlan, grantPlan, markPlan], {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.exposure.expose",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
      // Refresh after EVERY non-dry-run success, including idempotent
      // replays: a refresh that threw after an earlier commit is otherwise
      // stuck until process restart, because the replay path used to skip
      // the refresh and any new key would die in preflight.
      if (input.dryRun !== true) {
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
      // Fail closed inside the same transaction: a REVOKE removes only
      // grants made by the revoker, so a privilege on this table granted
      // to the runtime role by ANOTHER role would survive and leave the
      // table reachable after its registry row says unexposed. The guard
      // statement raises when any residual SELECT/INSERT/UPDATE (column
      // level) or DELETE (table level) remains, rolling the registry row
      // back with it.
      const verifyPlan = compileVerifyRuntimePrivilegesRevoked({
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
      const outcome = await execute([revokePlan, verifyPlan, markPlan], {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.exposure.unexpose",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
      if (input.dryRun !== true) {
        await deps.refreshRuntimeRegistry()
      }
      return outcome
    },
  }
}
