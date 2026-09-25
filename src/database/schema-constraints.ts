// Typed index, unique-constraint, and foreign-key commands for microJBase
// v0.2 (V02-11..V02-12).
//
// This module extends the V02-07..V02-09 command layer with the allowlisted
// index and constraint operations. The invariants established there hold
// unchanged (D-027): replay first, catalogue-backed preflight guards, exact
// ownership requirements, compilation only through the sealed V02-06
// compiler, and transactional executor semantics with durable history.
// Wave-4-specific invariants:
//
// - Only module-managed shapes compile: plain column lists over verified
//   columns, deterministic or validated explicit names, and no expression,
//   predicate, or concurrent index modes (those constructs have no typed
//   representation at all). Unsupported catalogue constructs stay read-only
//   metadata; the commands never touch them.
// - Foreign keys use the frozen action allowlist (NO ACTION, RESTRICT,
//   CASCADE, SET NULL); SET DEFAULT has no representation. SET NULL compiles
//   only after the service has verified every referencing column is
//   nullable. Referenced targets must exist in the immutable catalogue and
//   be owned by the schema-admin role alongside the referencing table.
// - Primary keys are managed solely by the table lifecycle (V02-07): the
//   managed "id" uuid primary key is created with the table and drops with
//   it. dropConstraint refuses primary keys, and no add-primary-key command
//   exists.
// - Index and constraint management is allowed on exposed tables: it does
//   not change the frozen data-API column contract the exposure registry
//   snapshots. Ownership and internal-object guards still apply.
//
// No HTTP mapping exists yet; the V02-18 admin API will call these commands
// with operator authentication and idempotency keys.

import type {
  JsonValue,
  SchemaCatalogue,
  SchemaCatalogueReader,
  SchemaCatalogueTable,
} from "../contracts/index.js"
import { AppError } from "../core/index.js"

import {
  compileAddForeignKey,
  compileAddUniqueConstraint,
  compileCreateIndex,
  compileDropConstraint,
  compileDropIndex,
  deterministicObjectName,
  type ExecuteOptions,
  type ExecuteOutcome,
  type ForeignKeyAction,
  type SchemaDdlExecutor,
} from "./schema-ddl.js"
import type { Pool } from "./pool.js"
import { mapCatalogueType } from "./schema-mutations.js"
import { createSchemaOperationLog } from "./schema-operation-log.js"
import { classifySchemaObject } from "./schema-snapshot.js"

export interface ConstraintCommandBase {
  /** D-025 idempotency key; replay/conflict semantics enforced by the log. */
  readonly idempotencyKey: string
  /** Operator actor label; only its HMAC fingerprint is persisted. */
  readonly actor: string
  /** Compile and preflight, then roll everything back; no history is written. */
  readonly dryRun?: boolean
}

export interface CreateIndexCommand extends ConstraintCommandBase {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
  /** Explicit name; validated, otherwise a deterministic name is derived. */
  readonly name?: string
}

export interface DropIndexCommand extends ConstraintCommandBase {
  readonly schema: string
  readonly table: string
  readonly name: string
}

export interface AddUniqueConstraintCommand extends ConstraintCommandBase {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
  /** Explicit name; validated, otherwise a deterministic name is derived. */
  readonly name?: string
}

export interface DropConstraintCommand extends ConstraintCommandBase {
  readonly schema: string
  readonly table: string
  readonly name: string
}

export interface ForeignKeyReferenceCommand {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
}

export interface AddForeignKeyCommand extends ConstraintCommandBase {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
  readonly references: ForeignKeyReferenceCommand
  readonly onUpdate: ForeignKeyAction
  readonly onDelete: ForeignKeyAction
  /** Explicit name; validated, otherwise a deterministic name is derived. */
  readonly name?: string
}

export interface SchemaConstraintService {
  createIndex(input: CreateIndexCommand): Promise<ExecuteOutcome>
  dropIndex(input: DropIndexCommand): Promise<ExecuteOutcome>
  addUniqueConstraint(
    input: AddUniqueConstraintCommand,
  ): Promise<ExecuteOutcome>
  dropConstraint(input: DropConstraintCommand): Promise<ExecuteOutcome>
  addForeignKey(input: AddForeignKeyCommand): Promise<ExecuteOutcome>
}

export interface SchemaConstraintServiceDependencies {
  /** Admin-lane pool used only for parameterised preflight reads. */
  readonly pool: Pool
  /** Read-only catalogue used for preflight guards. */
  readonly catalogue: SchemaCatalogueReader
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
  if (classifySchemaObject(schema.toLowerCase()) !== "operator") {
    throw validation("Internal schemas cannot be modified")
  }
}

/**
 * Create the typed index/constraint command service. The shape mirrors the
 * V02-07..V02-09 mutation service: replay-first key handling, catalogue
 * preflight for new keys, compilation through the sealed compiler, and
 * execution through the D-025/D-017 executor.
 */
export function createSchemaConstraintService(
  deps: SchemaConstraintServiceDependencies,
): SchemaConstraintService {
  const operationLog = createSchemaOperationLog({
    query: (text, values) => deps.pool.query(text, values),
  })

  async function hasExistingRecord(idempotencyKey: string): Promise<boolean> {
    return (await operationLog.get(idempotencyKey)) !== null
  }

  async function readCatalogue(): Promise<SchemaCatalogue> {
    return deps.catalogue.read()
  }

  async function requireTable(
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
    return found
  }

  function assertOwned(table: SchemaCatalogueTable, label: string): void {
    if (table.owner !== deps.adminRole) {
      throw validation(
        `${label} is not owned by the schema-admin role and cannot be modified`,
      )
    }
  }

  function requireColumns(
    table: SchemaCatalogueTable,
    columns: readonly string[],
  ): void {
    for (const column of columns) {
      if (!table.columns.some((entry) => entry.name === column)) {
        throw notFound(`Column ${column} does not exist on ${table.name}`)
      }
    }
  }

  function findIndexOwner(
    catalogue: SchemaCatalogue,
    schema: string,
    name: string,
  ): SchemaCatalogueTable | null {
    const schemaObject = catalogue.schemas.find(
      (entry) => entry.name === schema,
    )
    if (schemaObject === undefined) {
      return null
    }
    for (const table of schemaObject.tables) {
      if (table.indexes.some((index) => index.name === name)) {
        return table
      }
    }
    return null
  }

  function findConstraint(
    table: SchemaCatalogueTable,
    name: string,
  ): SchemaCatalogueTable["constraints"][number] | null {
    return (
      table.constraints.find((constraint) => constraint.name === name) ?? null
    )
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
    async createIndex(input: CreateIndexCommand): Promise<ExecuteOutcome> {
      if (!(await hasExistingRecord(input.idempotencyKey))) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table, "Table")
        requireColumns(table, input.columns)
        const name =
          input.name ??
          deterministicObjectName("idx", input.table, input.columns)
        if (findIndexOwner(catalogue, input.schema, name) !== null) {
          throw conflict(`Index ${name} already exists`)
        }
        if (findConstraint(table, name) !== null) {
          throw conflict(`Constraint ${name} already exists`)
        }
      }

      const plan = compileCreateIndex({
        schema: input.schema,
        table: input.table,
        columns: input.columns,
        ...(input.name !== undefined ? { name: input.name } : {}),
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        columns: [...input.columns],
        ...(input.name !== undefined ? { name: input.name } : {}),
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.index.create",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async dropIndex(input: DropIndexCommand): Promise<ExecuteOutcome> {
      if (!(await hasExistingRecord(input.idempotencyKey))) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table, "Table")
        const listed = table.indexes.some((index) => index.name === input.name)
        if (!listed) {
          if (findConstraint(table, input.name) !== null) {
            throw conflict(
              `${input.name} is backed by a constraint; drop the constraint instead`,
            )
          }
          const owner = findIndexOwner(catalogue, input.schema, input.name)
          if (owner !== null) {
            throw conflict(
              `Index ${input.name} belongs to ${owner.name}, not ${input.table}`,
            )
          }
          throw notFound(`Index ${input.name} does not exist`)
        }
      }

      const plan = compileDropIndex({ schema: input.schema, name: input.name })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        name: input.name,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.index.drop",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async addUniqueConstraint(
      input: AddUniqueConstraintCommand,
    ): Promise<ExecuteOutcome> {
      if (!(await hasExistingRecord(input.idempotencyKey))) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table, "Table")
        requireColumns(table, input.columns)
        const name =
          input.name ??
          deterministicObjectName("uniq", input.table, input.columns)
        if (findConstraint(table, name) !== null) {
          throw conflict(`Constraint ${name} already exists`)
        }
        if (findIndexOwner(catalogue, input.schema, name) !== null) {
          throw conflict(`Index ${name} already exists`)
        }
      }

      const plan = compileAddUniqueConstraint({
        schema: input.schema,
        table: input.table,
        columns: input.columns,
        ...(input.name !== undefined ? { name: input.name } : {}),
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        columns: [...input.columns],
        ...(input.name !== undefined ? { name: input.name } : {}),
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.constraint.unique.add",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async dropConstraint(
      input: DropConstraintCommand,
    ): Promise<ExecuteOutcome> {
      if (!(await hasExistingRecord(input.idempotencyKey))) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table, "Table")
        const constraint = findConstraint(table, input.name)
        if (constraint === null) {
          throw notFound(`Constraint ${input.name} does not exist`)
        }
        if (constraint.classification === "primary_key") {
          throw validation(
            "Primary keys are managed by the table lifecycle and cannot be dropped directly",
          )
        }
        if (
          constraint.classification === "check" ||
          constraint.classification === "exclusion"
        ) {
          throw validation(
            `${constraint.classification} constraints are read-only metadata and cannot be managed`,
          )
        }
      }

      const plan = compileDropConstraint({
        schema: input.schema,
        table: input.table,
        name: input.name,
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        name: input.name,
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.constraint.drop",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },

    async addForeignKey(input: AddForeignKeyCommand): Promise<ExecuteOutcome> {
      if (!(await hasExistingRecord(input.idempotencyKey))) {
        const catalogue = await readCatalogue()
        const table = await requireTable(catalogue, input.schema, input.table)
        assertOwned(table, "Referencing table")
        const target = await requireTable(
          catalogue,
          input.references.schema,
          input.references.table,
        )
        assertOwned(target, "Referenced table")
        requireColumns(table, input.columns)
        requireColumns(target, input.references.columns)
        if (input.columns.length !== input.references.columns.length) {
          throw validation(
            "A foreign key must reference the same number of columns it constrains",
          )
        }
        if (input.onUpdate === "set_null" || input.onDelete === "set_null") {
          for (const column of input.columns) {
            const catalogued = table.columns.find(
              (entry) => entry.name === column,
            )
            if (catalogued === undefined || !catalogued.isNullable) {
              throw validation(
                "SET NULL requires every referencing column to be nullable",
              )
            }
          }
        }
        for (let i = 0; i < input.columns.length; i += 1) {
          const referencing = table.columns.find(
            (entry) => entry.name === input.columns[i],
          )
          const referenced = target.columns.find(
            (entry) => entry.name === input.references.columns[i],
          )
          if (referencing === undefined || referenced === undefined) {
            continue
          }
          const fromType = mapCatalogueType(referencing.renderedType)
          const toType = mapCatalogueType(referenced.renderedType)
          if (fromType !== null && toType !== null && fromType !== toType) {
            throw validation(
              `Foreign key column types must match (${referencing.renderedType} references ${referenced.renderedType})`,
            )
          }
        }
        const name =
          input.name ??
          deterministicObjectName("fkey", input.table, input.columns)
        if (findConstraint(table, name) !== null) {
          throw conflict(`Constraint ${name} already exists`)
        }
      }

      const plan = compileAddForeignKey({
        schema: input.schema,
        table: input.table,
        columns: input.columns,
        references: input.references,
        onUpdate: input.onUpdate,
        onDelete: input.onDelete,
        ...(input.name !== undefined ? { name: input.name } : {}),
      })
      const command: JsonValue = {
        schema: input.schema,
        table: input.table,
        columns: [...input.columns],
        references: {
          schema: input.references.schema,
          table: input.references.table,
          columns: [...input.references.columns],
        },
        onUpdate: input.onUpdate,
        onDelete: input.onDelete,
        ...(input.name !== undefined ? { name: input.name } : {}),
      }
      return execute(plan, {
        idempotencyKey: input.idempotencyKey,
        commandType: "schema.foreign_key.add",
        command,
        actor: input.actor,
        dryRun: input.dryRun,
      })
    },
  }
}
