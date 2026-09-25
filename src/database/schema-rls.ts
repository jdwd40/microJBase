// Row-security state management and predefined ownership policy templates
// for microJBase v0.2 (V02-14..V02-15, D-019).
//
// This module is the operator-facing command layer for wave 5 on top of the
// V02-06 DDL substrate. It follows the same replay-first command pattern as
// the earlier waves: the durable operation log is consulted before any
// preflight guard, compilation happens only through the sealed compiler in
// schema-ddl.ts, and execution goes through the D-025/D-017 executor, so
// every change is serialized, recorded with a checksum, and commits or rolls
// back atomically. Wave-5-specific invariants:
//
// - RLS enablement always enables AND forces row-level security, so the
//   table owner and every other session are subject to the same policies as
//   the pooled runtime lane. Disable requests fail closed: the table must
//   not be exposed to the data API, the operator must pass the exact
//   "schema.table" confirmation, internal targets are refused before SQL
//   exists, and only tables owned by the schema-admin role are touched.
// - Ownership policy templates are the only policy shape (D-019): four
//   named templates (read, insert, update, delete) bound to the fixed
//   microjbase.user_id comparison over a validated UUID ownership column,
//   applied TO the restricted runtime role. There is no arbitrary policy
//   expression anywhere in the command or the compiler.
// - Template creation validates the ownership column from the immutable
//   catalogue (exact uuid rendering, not generated, not identity) and
//   refuses duplicate module-created policies. Template removal addresses
//   policies only by the deterministic module-owned name, so it can never
//   touch operator-authored policies and never restores or reconstructs
//   arbitrary prior policy expressions.
// - Policy commands run as the schema-admin role, which PostgreSQL requires
//   to be the table owner; the catalogue ownership guard enforces that
//   before compilation, and the executor pins the session so no SET ROLE or
//   superuser escalation path exists.
//
// No HTTP mapping exists yet; the V02-18 admin API will call these commands
// with operator authentication and idempotency keys.

import type {
  JsonValue,
  SchemaCatalogue,
  SchemaCatalogueReader,
  SchemaCatalogueTable,
  TableRegistry,
} from "../contracts/index.js"
import { AppError } from "../core/index.js"

import type { Pool } from "./pool.js"
import {
  compileCreateOwnershipPolicy,
  compileDisableRowSecurity,
  compileDropOwnershipPolicy,
  compileEnableRowSecurity,
  type ExecuteOptions,
  type ExecuteOutcome,
  type OwnershipPolicyTemplate,
  ownershipPolicyName,
  type SchemaDdlExecutor,
} from "./schema-ddl.js"
import { mapCatalogueType } from "./schema-mutations.js"
import { createSchemaOperationLog } from "./schema-operation-log.js"
import { classifySchemaObject } from "./schema-snapshot.js"

export interface RlsCommandBase {
  /** D-025 idempotency key; replay/conflict semantics enforced by the log. */
  readonly idempotencyKey: string
  /** Operator actor label; only its HMAC fingerprint is persisted. */
  readonly actor: string
  /** Compile and preflight, then roll everything back; no history is written. */
  readonly dryRun?: boolean
}

export interface EnableRowSecurityCommand extends RlsCommandBase {
  readonly schema: string
  readonly table: string
}

export interface DisableRowSecurityCommand extends RlsCommandBase {
  readonly schema: string
  readonly table: string
  /** Must equal `${schema}.${table}` exactly (D-015 destructive shape). */
  readonly confirm: string
}

export interface CreateOwnershipPolicyCommand extends RlsCommandBase {
  readonly schema: string
  readonly table: string
  /** UUID ownership column the template binds to. */
  readonly column: string
  readonly template: OwnershipPolicyTemplate
}

export interface RemoveOwnershipPolicyCommand extends RlsCommandBase {
  readonly schema: string
  readonly table: string
  /** UUID ownership column the template binds to. */
  readonly column: string
  readonly template: OwnershipPolicyTemplate
}

export interface SchemaRlsService {
  enableRowSecurity(input: EnableRowSecurityCommand): Promise<ExecuteOutcome>
  disableRowSecurity(input: DisableRowSecurityCommand): Promise<ExecuteOutcome>
}

export interface SchemaPolicyService {
  createOwnershipPolicy(
    input: CreateOwnershipPolicyCommand,
  ): Promise<ExecuteOutcome>
  removeOwnershipPolicy(
    input: RemoveOwnershipPolicyCommand,
  ): Promise<ExecuteOutcome>
}

export interface SchemaRlsServiceDependencies {
  /** Admin-lane pool used only for parameterised preflight reads. */
  readonly pool: Pool
  /** Read-only catalogue used for preflight guards. */
  readonly catalogue: SchemaCatalogueReader
  /** v0.1 exposure registry consulted by the fail-closed disable guard. */
  readonly registry: TableRegistry
  /** The schema-admin role name; managed tables must be owned by it. */
  readonly adminRole: string
  /** Sealed-plan executor from the V02-06 substrate. */
  readonly executor: SchemaDdlExecutor
  readonly logger?: Pick<Console, "error" | "warn" | "info" | "debug">
}

export interface SchemaPolicyServiceDependencies {
  /** Admin-lane pool used only for parameterised preflight reads. */
  readonly pool: Pool
  /** Read-only catalogue used for preflight guards. */
  readonly catalogue: SchemaCatalogueReader
  /** The schema-admin role name; managed tables must be owned by it. */
  readonly adminRole: string
  /** The restricted runtime role the ownership policies apply TO. */
  readonly runtimeRole: string
  /** Sealed-plan executor from the V02-06 substrate. */
  readonly executor: SchemaDdlExecutor
  readonly logger?: Pick<Console, "error" | "warn" | "info" | "debug">
}

function validation(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, 400)
}

function notFound(message: string): AppError {
  return new AppError("TABLE_NOT_FOUND", message, 404)
}

function conflict(message: string): AppError {
  return new AppError("CONFLICT", message, 409)
}

function assertOperatorSchema(schema: string): void {
  // Case-insensitive, matching the compiler's assertManageableSchema:
  // unquoted PostgreSQL identifiers fold to lowercase, so a lookalike such
  // as PG_catalog names the same internal catalog the denylist names.
  if (classifySchemaObject(schema.toLowerCase()) !== "operator") {
    throw validation("Internal schemas cannot be modified")
  }
}

function isSimpleIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/i.test(name)
}

export function createSchemaRlsService(
  deps: SchemaRlsServiceDependencies,
): SchemaRlsService {
  const operationLog = createSchemaOperationLog({
    query: (text, values) => deps.pool.query(text, values),
  })

  async function hasExistingRecord(idempotencyKey: string): Promise<boolean> {
    return (await operationLog.get(idempotencyKey)) !== null
  }

  // Guards run for every new key AND for every dry run: the executor's
  // dry-run branch still issues the compiled statements (inside a rollback),
  // so a reused key must not bypass confirmation, ownership, or exposure
  // checks (D-027).
  async function preflightApplies(input: RlsCommandBase): Promise<boolean> {
    return (
      input.dryRun === true || !(await hasExistingRecord(input.idempotencyKey))
    )
  }

  async function readCatalogue(): Promise<SchemaCatalogue> {
    return deps.catalogue.read()
  }

  async function requireOwnedTable(
    catalogue: SchemaCatalogue,
    schema: string,
    table: string,
  ): Promise<SchemaCatalogueTable> {
    assertOperatorSchema(schema)
    const schemaObject = catalogue.schemas.find(
      (entry) => entry.name === schema,
    )
    if (schemaObject === undefined) {
      throw notFound("Referenced schema does not exist")
    }
    const found = schemaObject.tables.find((entry) => entry.name === table)
    if (found === undefined) {
      throw notFound("Referenced table does not exist")
    }
    if (found.owner !== deps.adminRole) {
      throw validation(
        "Only tables owned by the schema-admin role can be mutated",
      )
    }
    return found
  }

  function assertNotExposed(schema: string, table: string): void {
    const exposed = deps.registry
      .list()
      .some((entry) => entry.schema === schema && entry.table === table)
    if (exposed) {
      throw conflict(
        "Table is exposed to the data API and row-level security cannot be disabled",
      )
    }
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
    async enableRowSecurity(
      input: EnableRowSecurityCommand,
    ): Promise<ExecuteOutcome> {
      if (!isSimpleIdentifier(input.table)) {
        throw validation("Invalid SQL identifier")
      }
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        await requireOwnedTable(catalogue, input.schema, input.table)
      }

      const plan = compileEnableRowSecurity({
        schema: input.schema,
        table: input.table,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.rls.enable",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async disableRowSecurity(
      input: DisableRowSecurityCommand,
    ): Promise<ExecuteOutcome> {
      if (!isSimpleIdentifier(input.table)) {
        throw validation("Invalid SQL identifier")
      }
      if (await preflightApplies(input)) {
        if (input.confirm !== `${input.schema}.${input.table}`) {
          throw validation(
            'Disabling row-level security requires the exact confirmation value "schema.table"',
          )
        }
        const catalogue = await readCatalogue()
        await requireOwnedTable(catalogue, input.schema, input.table)
        // Fail closed: an exposed table whose row security was disabled would
        // let the pooled runtime lane read and write every user's rows, so
        // the disable command refuses while the table is exposed.
        assertNotExposed(input.schema, input.table)
      }

      const plan = compileDisableRowSecurity({
        schema: input.schema,
        table: input.table,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        confirmed: true,
      }
      // The compiled plan itself leads with the locked exposure guard: the
      // in-memory registry the preflight read can be stale by the time the
      // executor reaches the advisory lock, so the durable registry is
      // re-checked as the first statement and the disable fails closed there
      // instead. No separate guard plan is prepended here.
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.rls.disable",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },
  }
}

export function createSchemaPolicyService(
  deps: SchemaPolicyServiceDependencies,
): SchemaPolicyService {
  const operationLog = createSchemaOperationLog({
    query: (text, values) => deps.pool.query(text, values),
  })

  async function hasExistingRecord(idempotencyKey: string): Promise<boolean> {
    return (await operationLog.get(idempotencyKey)) !== null
  }

  async function preflightApplies(input: RlsCommandBase): Promise<boolean> {
    return (
      input.dryRun === true || !(await hasExistingRecord(input.idempotencyKey))
    )
  }

  async function readCatalogue(): Promise<SchemaCatalogue> {
    return deps.catalogue.read()
  }

  async function requireOwnedTable(
    catalogue: SchemaCatalogue,
    schema: string,
    table: string,
  ): Promise<SchemaCatalogueTable> {
    assertOperatorSchema(schema)
    const schemaObject = catalogue.schemas.find(
      (entry) => entry.name === schema,
    )
    if (schemaObject === undefined) {
      throw notFound("Referenced schema does not exist")
    }
    const found = schemaObject.tables.find((entry) => entry.name === table)
    if (found === undefined) {
      throw notFound("Referenced table does not exist")
    }
    if (found.owner !== deps.adminRole) {
      throw validation(
        "Only tables owned by the schema-admin role can be mutated",
      )
    }
    return found
  }

  async function policyExists(
    schema: string,
    table: string,
    name: string,
  ): Promise<boolean> {
    // Parameterised existence probe; the compiled statement derives the name
    // from the same deterministic helper, so the probe and the statement can
    // never drift apart.
    const result = await deps.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_policy pol
         JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND pol.polname = $3
       ) AS present`,
      [schema, table, name],
    )
    const row = result.rows[0]
    if (row === undefined || typeof row.present !== "boolean") {
      throw new AppError("INTERNAL_ERROR", "Schema operation failed", 500)
    }
    return row.present
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
    async createOwnershipPolicy(
      input: CreateOwnershipPolicyCommand,
    ): Promise<ExecuteOutcome> {
      if (
        !isSimpleIdentifier(input.table) ||
        !isSimpleIdentifier(input.column)
      ) {
        throw validation("Invalid SQL identifier")
      }
      const name = ownershipPolicyName(
        input.table,
        input.column,
        input.template,
      )
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        const table = await requireOwnedTable(
          catalogue,
          input.schema,
          input.table,
        )
        const ownershipColumn = table.columns.find(
          (entry) => entry.name === input.column,
        )
        if (ownershipColumn === undefined) {
          throw notFound("Referenced column does not exist")
        }
        if (
          ownershipColumn.generated !== "none" ||
          ownershipColumn.identity !== "none"
        ) {
          throw validation(
            "Generated and identity columns cannot be ownership columns",
          )
        }
        if (mapCatalogueType(ownershipColumn.renderedType) !== "uuid") {
          throw validation("Ownership column must be type uuid")
        }
        if (await policyExists(input.schema, input.table, name)) {
          throw conflict(`Ownership policy ${name} already exists`)
        }
      }

      const plan = compileCreateOwnershipPolicy({
        schema: input.schema,
        table: input.table,
        column: input.column,
        template: input.template,
        role: deps.runtimeRole,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
        template: input.template,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.policy.create",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async removeOwnershipPolicy(
      input: RemoveOwnershipPolicyCommand,
    ): Promise<ExecuteOutcome> {
      if (
        !isSimpleIdentifier(input.table) ||
        !isSimpleIdentifier(input.column)
      ) {
        throw validation("Invalid SQL identifier")
      }
      const name = ownershipPolicyName(
        input.table,
        input.column,
        input.template,
      )
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        await requireOwnedTable(catalogue, input.schema, input.table)
        // Removal addresses only the deterministic module-created name; it
        // never touches operator-authored policies and never attempts to
        // restore or reconstruct arbitrary prior policy expressions.
        if (!(await policyExists(input.schema, input.table, name))) {
          throw conflict(`Ownership policy ${name} does not exist`)
        }
      }

      const plan = compileDropOwnershipPolicy({
        schema: input.schema,
        table: input.table,
        column: input.column,
        template: input.template,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
        template: input.template,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.policy.remove",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },
  }
}
