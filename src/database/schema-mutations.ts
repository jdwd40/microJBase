// Typed table and column mutation commands for microJBase v0.2 (V02-07..V02-09).
//
// This module is the operator-facing command layer on top of the V02-06 DDL
// substrate. Every command compiles a sealed plan through the single audited
// compiler in schema-ddl.ts and executes it through the transactional,
// idempotency-keyed executor, so the operation-history guarantees (D-025) and
// the advisory serialization (D-017) apply unchanged. Invariants:
//
// - Replay first: the operation log is consulted before any preflight guard.
//   When a record already exists for the idempotency key, the preflight
//   guards are bypassed and the executor alone classifies the begin outcome
//   (replay, checksum conflict, retry-of-failure, in-progress). Stateful
//   guards such as "relation already exists" must therefore never shadow the
//   D-025 replay contract for a retried key. A missing or unreadable record
//   simply means "not seen before" and preflight runs normally. Commands that
//   embed a catalogue-derived type in their compiled statement
//   (changeColumnType, setColumnDefault) reconstruct that type from the
//   recorded command on this path, never from the live catalogue: the
//   recorded outcome is authoritative, and the live type may legitimately
//   have moved on (or the table may be gone) after a recorded success.
// - Dry runs always preflight: a reused key must not let a dry run skip the
//   confirmation, ownership, exposure, or dependency guards, because the
//   executor's dry-run branch still issues the compiled statements inside a
//   rolled-back transaction (D-027).
// - Preflight guards run before compilation for new keys and reject with
//   stable error codes, so a refused command never reaches the executor and
//   never writes history. Preflight reads the immutable catalogue reader
//   (V02-01..V02-03) and parameterised existence/count queries over the
//   admin pool; it is an early, friendly gate, not a security boundary — the
//   compiled statements remain the single source of truth and PostgreSQL
//   re-validates everything inside the DDL transaction.
// - Internal targets (microjbase, pg_catalog, information_schema, pg_* —
//   case-insensitively) are refused before SQL exists. Managed tables refuse
//   reserved names (the PostgreSQL-reserved pg_ prefix and any case-variant
//   of the id primary-key column).
// - Ownership: a table is mutated only when the catalogue reports it owned by
//   the configured schema-admin role (D-011); anything else fails closed.
// - Exposure: a table listed by the injected v0.1 TableRegistry is API-exposed
//   and cannot be renamed, dropped, or column-mutated until a later wave
//   unexposes it (D-015).
// - Destructive drops require the exact confirmation value "schema.table" or
//   "schema.table.column"; anything else is a 400 and no plan is compiled.
//   Confirmation is validated on first execution; a replayed key returns the
//   recorded outcome without re-confirmation.
// - Safeguarded columns: generated (stored/virtual) and identity columns are
//   never dropped, renamed, defaulted, or type-changed; the primary-key
//   column is never dropped, renamed, or type-changed.
// - Dependencies visible in the catalogue (constraints and indexes) refuse
//   drops of their columns and refuse drops of referenced tables. Views are
//   outside the catalogue contract; PostgreSQL itself refuses DROP TABLE on a
//   table a view depends on, and the executor maps that to a safe envelope.
//
// No HTTP mapping exists yet; the V02-18 admin API will call these commands
// with operator authentication, idempotency keys, and the same confirmations.

import type {
  JsonValue,
  SchemaCatalogue,
  SchemaCatalogueColumn,
  SchemaCatalogueReader,
  SchemaCatalogueSchema,
  SchemaCatalogueTable,
  TableRegistry,
} from "../contracts/index.js"
import { AppError } from "../core/index.js"

import { quoteIdentifier } from "./identifier.js"
import type { Pool } from "./pool.js"
import {
  assertDdlIdentifier,
  compileAddColumn,
  compileChangeColumnType,
  compileCreateTable,
  compileDropColumn,
  compileDropColumnDefault,
  compileDropNotNull,
  compileDropTable,
  compileRenameColumn,
  compileRenameTable,
  compileSetColumnDefault,
  compileSetNotNull,
  type DdlColumnDefault,
  type DdlColumnType,
  type ExecuteOptions,
  type ExecuteOutcome,
  isDdlColumnType,
  type SchemaDdlExecutor,
} from "./schema-ddl.js"
import {
  createSchemaOperationLog,
  type SchemaOperationRecord,
} from "./schema-operation-log.js"
import { classifySchemaObject } from "./schema-snapshot.js"

export interface MutationCommandBase {
  /** D-025 idempotency key; replay/conflict semantics enforced by the log. */
  readonly idempotencyKey: string
  /** Operator actor label; only its HMAC fingerprint is persisted. */
  readonly actor: string
  /** Compile and preflight, then roll everything back; no history is written. */
  readonly dryRun?: boolean
}

export interface CreateTableCommand extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  /** Operator columns; the managed "id" uuid primary key is added by the command. */
  readonly columns: readonly ManagedColumnSpec[]
}

export interface ManagedColumnSpec {
  readonly name: string
  readonly type: DdlColumnType
  readonly nullable: boolean
  readonly default: DdlColumnDefault
}

export interface RenameTableCommand extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  readonly newName: string
}

export interface DropTableCommand extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  /** Must equal `${schema}.${table}` exactly. */
  readonly confirm: string
}

export interface AddColumnCommand extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  readonly column: ManagedColumnSpec
}

export interface RenameColumnCommand extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly newName: string
}

export interface DropColumnCommand extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  readonly column: string
  /** Must equal `${schema}.${table}.${column}` exactly. */
  readonly confirm: string
}

export interface SetColumnDefaultCommand extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly default: DdlColumnDefault
}

export interface ColumnCommandBase extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  readonly column: string
}

export interface ChangeColumnTypeCommand extends MutationCommandBase {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly toType: DdlColumnType
}

export interface SchemaMutationService {
  createTable(input: CreateTableCommand): Promise<ExecuteOutcome>
  renameTable(input: RenameTableCommand): Promise<ExecuteOutcome>
  dropTable(input: DropTableCommand): Promise<ExecuteOutcome>
  addColumn(input: AddColumnCommand): Promise<ExecuteOutcome>
  renameColumn(input: RenameColumnCommand): Promise<ExecuteOutcome>
  dropColumn(input: DropColumnCommand): Promise<ExecuteOutcome>
  setColumnDefault(input: SetColumnDefaultCommand): Promise<ExecuteOutcome>
  dropColumnDefault(input: ColumnCommandBase): Promise<ExecuteOutcome>
  setColumnNotNull(input: ColumnCommandBase): Promise<ExecuteOutcome>
  dropColumnNotNull(input: ColumnCommandBase): Promise<ExecuteOutcome>
  changeColumnType(input: ChangeColumnTypeCommand): Promise<ExecuteOutcome>
}

export interface SchemaMutationServiceDependencies {
  /** Admin-lane pool used only for parameterised preflight reads. */
  readonly pool: Pool
  /** Read-only catalogue used for preflight guards. */
  readonly catalogue: SchemaCatalogueReader
  /** v0.1 exposure registry consulted by the exposure guard. */
  readonly registry: TableRegistry
  /** The schema-admin role name; mutated tables must be owned by it. */
  readonly adminRole: string
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

// PostgreSQL reserves the pg_ prefix for system catalogs; a lookalike in
// either case is refused for managed tables.
function assertNotReservedTableName(name: string): void {
  if (name.toLowerCase().startsWith("pg_")) {
    throw validation("Table names starting with pg_ are reserved")
  }
}

// Managed tables always carry their "id" uuid primary key; operator columns
// may not use the name in any case variant.
function assertNotIdColumnName(name: string): void {
  if (name.toLowerCase() === "id") {
    throw validation('The "id" column is managed by the table lifecycle')
  }
}

function describeColumn(column: ManagedColumnSpec): JsonValue {
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    default: column.default,
  }
}

// Maps the catalogue's rendered type (format_type output) onto the frozen
// allowlist. Only exact renderings map: a varchar(n), a domain, an array, or
// any typmod-carrying type is outside the managed set and stays unmanageable.
export function mapCatalogueType(renderedType: string): DdlColumnType | null {
  switch (renderedType) {
    case "text":
      return "text"
    case "integer":
      return "integer"
    case "bigint":
      return "bigint"
    case "boolean":
      return "boolean"
    case "uuid":
      return "uuid"
    case "timestamp without time zone":
      return "timestamp"
    case "timestamp with time zone":
      return "timestamptz"
    case "date":
      return "date"
    case "numeric":
      return "numeric"
    case "jsonb":
      return "jsonb"
    default:
      return null
  }
}

function primaryKeyColumns(table: SchemaCatalogueTable): readonly string[] {
  for (const constraint of table.constraints) {
    if (constraint.classification === "primary_key") {
      return constraint.columns
    }
  }
  return []
}

function columnHasDependencies(
  table: SchemaCatalogueTable,
  column: string,
): boolean {
  const inConstraint = table.constraints.some((constraint) =>
    constraint.columns.includes(column),
  )
  if (inConstraint) {
    return true
  }
  return table.indexes.some((index) => index.columns.includes(column))
}

function countForeignKeyReferences(
  catalogue: SchemaCatalogue,
  schema: string,
  table: string,
): number {
  let count = 0
  for (const cataloguedSchema of catalogue.schemas) {
    for (const cataloguedTable of cataloguedSchema.tables) {
      for (const constraint of cataloguedTable.constraints) {
        // A self-referencing foreign key belongs to the table being dropped
        // and drops with it; only references from other tables block the
        // drop, matching what PostgreSQL itself enforces.
        if (
          constraint.references !== null &&
          constraint.references.schema === schema &&
          constraint.references.table === table &&
          (cataloguedTable.schema !== schema || cataloguedTable.name !== table)
        ) {
          count += 1
        }
      }
    }
  }
  return count
}

const ID_COLUMN_SPEC: ManagedColumnSpec = {
  name: "id",
  type: "uuid",
  nullable: false,
  default: { kind: "random_uuid" },
}

/**
 * Create the typed mutation command service. New keys run preflight guards
 * against the catalogue reader and the injected registry before compilation;
 * every execution goes through the injected V02-06 executor, and keys with an
 * existing operation record are handed straight to the executor so replay and
 * conflict semantics stay authoritative (D-025).
 */
export function createSchemaMutationService(
  deps: SchemaMutationServiceDependencies,
): SchemaMutationService {
  // Read-side view of the durable operation log over the admin pool. Only
  // get() is used: a existence probe that decides whether preflight guards
  // apply. The executor owns all writes through its own transaction.
  const operationLog = createSchemaOperationLog({
    query: (text, values) => deps.pool.query(text, values),
  })

  async function hasExistingRecord(idempotencyKey: string): Promise<boolean> {
    // A malformed key is rejected here with the same stable error the
    // executor would raise; database errors propagate unchanged.
    return (await operationLog.get(idempotencyKey)) !== null
  }

  // Guards run for every new key AND for every dry run: the executor's
  // dry-run branch still issues the compiled statements (inside a rollback),
  // so a reused key must not bypass confirmation/ownership/exposure/dependency
  // checks (D-027).
  async function preflightApplies(
    input: MutationCommandBase,
  ): Promise<boolean> {
    return (
      input.dryRun === true || !(await hasExistingRecord(input.idempotencyKey))
    )
  }

  async function readCatalogue(): Promise<SchemaCatalogue> {
    return deps.catalogue.read()
  }

  async function requireSchema(
    catalogue: SchemaCatalogue,
    schema: string,
  ): Promise<SchemaCatalogueSchema> {
    assertOperatorSchema(schema)
    const found = catalogue.schemas.find((entry) => entry.name === schema)
    if (found === undefined) {
      throw notFound("Referenced schema does not exist")
    }
    return found
  }

  async function requireTable(
    catalogue: SchemaCatalogue,
    schema: string,
    table: string,
  ): Promise<SchemaCatalogueTable> {
    const schemaObject = await requireSchema(catalogue, schema)
    const found = schemaObject.tables.find((entry) => entry.name === table)
    if (found === undefined) {
      throw notFound("Referenced table does not exist")
    }
    return found
  }

  function assertOwned(table: SchemaCatalogueTable): void {
    if (table.owner !== deps.adminRole) {
      throw validation(
        "Only tables owned by the schema-admin role can be mutated",
      )
    }
  }

  function assertNotExposed(schema: string, table: string): void {
    const exposed = deps.registry
      .list()
      .some((entry) => entry.schema === schema && entry.table === table)
    if (exposed) {
      throw conflict(
        "Table is exposed to the data API and must be unexposed before it can be mutated",
      )
    }
  }

  function requireColumn(
    table: SchemaCatalogueTable,
    column: string,
  ): SchemaCatalogueColumn {
    const found = table.columns.find((entry) => entry.name === column)
    if (found === undefined) {
      throw notFound("Referenced column does not exist")
    }
    return found
  }

  // Generated and identity columns are outside the managed lifecycle in both
  // directions: they cannot be created by the commands, and they cannot be
  // dropped, renamed, defaulted, or type-changed.
  function assertPlainColumn(column: SchemaCatalogueColumn): void {
    if (column.generated !== "none") {
      throw validation("Generated columns cannot be modified")
    }
    if (column.identity !== "none") {
      throw validation("Identity columns cannot be modified")
    }
  }

  function assertNotPrimaryKeyColumn(
    table: SchemaCatalogueTable,
    column: string,
  ): void {
    if (primaryKeyColumns(table).includes(column)) {
      throw validation("Primary key columns cannot be modified")
    }
  }

  async function tableHasRows(schema: string, table: string): Promise<boolean> {
    const result = await deps.pool.query<{ has_rows: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} LIMIT 1) AS has_rows`,
    )
    const row = result.rows[0]
    if (row === undefined || typeof row.has_rows !== "boolean") {
      throw new AppError("INTERNAL_ERROR", "Schema operation failed", 500)
    }
    return row.has_rows
  }

  async function columnHasNulls(
    schema: string,
    table: string,
    column: string,
  ): Promise<boolean> {
    const result = await deps.pool.query<{ has_nulls: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NULL LIMIT 1) AS has_nulls`,
    )
    const row = result.rows[0]
    if (row === undefined || typeof row.has_nulls !== "boolean") {
      throw new AppError("INTERNAL_ERROR", "Schema operation failed", 500)
    }
    return row.has_nulls
  }

  // Reads a type field back from the recorded command of an existing
  // operation. On the replay path the executor already owns the outcome and
  // compilation only needs to render the identical statement for the
  // checksum comparison, so the recorded command — never the live catalogue —
  // is the source of truth: after a recorded success the live type may
  // legitimately have moved on (or the table may be gone), and re-deriving
  // the type from the catalogue would wrongly reject the replay (D-025).
  function recordedCommandType(
    record: SchemaOperationRecord,
    field: "fromType" | "type",
  ): DdlColumnType {
    const command = record.command
    const value =
      typeof command === "object" && command !== null && !Array.isArray(command)
        ? (command as Record<string, JsonValue>)[field]
        : undefined
    if (!isDdlColumnType(value)) {
      throw new AppError(
        "INTERNAL_ERROR",
        `Malformed schema operation record: command.${field} is not a managed column type`,
        500,
      )
    }
    return value
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
    async createTable(input: CreateTableCommand): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertNotReservedTableName(input.table)
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        const schemaObject = await requireSchema(catalogue, input.schema)
        if (schemaObject.tables.some((entry) => entry.name === input.table)) {
          throw conflict("Relation already exists")
        }
        if (input.columns.length === 0) {
          throw validation("a table needs at least one column")
        }
        for (const column of input.columns) {
          assertDdlIdentifier(column.name)
          assertNotIdColumnName(column.name)
        }
      }

      const plan = compileCreateTable({
        schema: input.schema,
        table: input.table,
        columns: [{ ...ID_COLUMN_SPEC, primaryKey: true }, ...input.columns],
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        columns: input.columns.map(describeColumn),
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.table.create",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async renameTable(input: RenameTableCommand): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.newName)
      assertNotReservedTableName(input.newName)
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        const schemaObject = await requireSchema(catalogue, input.schema)
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        if (schemaObject.tables.some((entry) => entry.name === input.newName)) {
          throw conflict("Relation already exists")
        }
      }

      const plan = compileRenameTable({
        schema: input.schema,
        table: input.table,
        newName: input.newName,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        newName: input.newName,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.table.rename",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async dropTable(input: DropTableCommand): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      if (await preflightApplies(input)) {
        if (input.confirm !== `${input.schema}.${input.table}`) {
          throw validation(
            'Destructive drops require the exact confirmation value "schema.table"',
          )
        }
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        const references = countForeignKeyReferences(
          catalogue,
          input.schema,
          input.table,
        )
        if (references > 0) {
          throw conflict(
            `Table is referenced by ${String(references)} foreign key constraint(s) and cannot be dropped`,
          )
        }
      }

      const plan = compileDropTable({
        schema: input.schema,
        table: input.table,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        confirmed: true,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.table.drop",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async addColumn(input: AddColumnCommand): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.column.name)
      assertNotIdColumnName(input.column.name)
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        if (table.columns.some((entry) => entry.name === input.column.name)) {
          throw conflict("Column already exists")
        }
        if (
          input.column.nullable === false &&
          input.column.default.kind === "none" &&
          (await tableHasRows(input.schema, input.table))
        ) {
          throw validation(
            "A NOT NULL column without a default cannot be added to a table with existing rows",
          )
        }
      }

      const plan = compileAddColumn({
        schema: input.schema,
        table: input.table,
        column: { ...input.column },
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: describeColumn(input.column),
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.column.add",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async renameColumn(input: RenameColumnCommand): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.column)
      assertDdlIdentifier(input.newName)
      assertNotIdColumnName(input.newName)
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        const column = requireColumn(table, input.column)
        assertPlainColumn(column)
        assertNotPrimaryKeyColumn(table, input.column)
        if (table.columns.some((entry) => entry.name === input.newName)) {
          throw conflict("Column already exists")
        }
      }

      const plan = compileRenameColumn({
        schema: input.schema,
        table: input.table,
        column: input.column,
        newName: input.newName,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
        newName: input.newName,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.column.rename",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async dropColumn(input: DropColumnCommand): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.column)
      if (await preflightApplies(input)) {
        if (
          input.confirm !== `${input.schema}.${input.table}.${input.column}`
        ) {
          throw validation(
            'Destructive drops require the exact confirmation value "schema.table.column"',
          )
        }
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        const column = requireColumn(table, input.column)
        assertPlainColumn(column)
        assertNotPrimaryKeyColumn(table, input.column)
        if (columnHasDependencies(table, input.column)) {
          throw conflict(
            "Column is used by a constraint or index and cannot be dropped",
          )
        }
      }

      const plan = compileDropColumn({
        schema: input.schema,
        table: input.table,
        column: input.column,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
        confirmed: true,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.column.drop",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async setColumnDefault(
      input: SetColumnDefaultCommand,
    ): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.column)
      let type: DdlColumnType
      const existing = await operationLog.get(input.idempotencyKey)
      if (input.dryRun === true || existing === null) {
        // A dry run simulates the command against the live catalogue even
        // for a reused key (it never consults history); a retried key
        // recompiles from the recorded command, never the live catalogue.
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        const column = requireColumn(table, input.column)
        assertPlainColumn(column)
        const mapped = mapCatalogueType(column.renderedType)
        if (mapped === null) {
          throw validation(
            "Column type is not managed by the schema type allowlist",
          )
        }
        type = mapped
      } else {
        type = recordedCommandType(existing, "type")
      }

      const plan = compileSetColumnDefault({
        schema: input.schema,
        table: input.table,
        column: input.column,
        type,
        default: input.default,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
        default: input.default,
        type,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.column.default.set",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async dropColumnDefault(input: ColumnCommandBase): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.column)
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        const column = requireColumn(table, input.column)
        assertPlainColumn(column)
      }

      const plan = compileDropColumnDefault({
        schema: input.schema,
        table: input.table,
        column: input.column,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.column.default.drop",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async setColumnNotNull(input: ColumnCommandBase): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.column)
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        requireColumn(table, input.column)
        if (await columnHasNulls(input.schema, input.table, input.column)) {
          throw validation(
            "Column contains NULL values and cannot be marked NOT NULL",
          )
        }
      }

      const plan = compileSetNotNull({
        schema: input.schema,
        table: input.table,
        column: input.column,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.column.not_null.set",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async dropColumnNotNull(input: ColumnCommandBase): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.column)
      if (await preflightApplies(input)) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        requireColumn(table, input.column)
      }

      const plan = compileDropNotNull({
        schema: input.schema,
        table: input.table,
        column: input.column,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.column.not_null.drop",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async changeColumnType(
      input: ChangeColumnTypeCommand,
    ): Promise<ExecuteOutcome> {
      assertDdlIdentifier(input.table)
      assertDdlIdentifier(input.column)
      let fromType: DdlColumnType
      const existing = await operationLog.get(input.idempotencyKey)
      if (input.dryRun === true || existing === null) {
        // A dry run simulates the command against the live catalogue even
        // for a reused key (it never consults history); a retried key
        // recompiles from the recorded command, never the live catalogue —
        // after a recorded success the catalogue legitimately shows the
        // destination type, which is not in the conversion matrix from
        // itself.
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table)
        assertNotExposed(input.schema, input.table)
        const column = requireColumn(table, input.column)
        assertPlainColumn(column)
        assertNotPrimaryKeyColumn(table, input.column)
        if (column.defaultExpression !== null) {
          throw validation(
            "Drop the column default before changing the column type",
          )
        }
        if (columnHasDependencies(table, input.column)) {
          throw conflict(
            "Column is used by a constraint or index and cannot be type-changed",
          )
        }
        const mapped = mapCatalogueType(column.renderedType)
        if (mapped === null) {
          throw validation(
            "Column type is not managed by the schema type allowlist",
          )
        }
        fromType = mapped
      } else {
        fromType = recordedCommandType(existing, "fromType")
      }

      const plan = compileChangeColumnType({
        schema: input.schema,
        table: input.table,
        column: input.column,
        fromType,
        toType: input.toType,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        column: input.column,
        fromType,
        toType: input.toType,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.column.type.change",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },
  }
}
