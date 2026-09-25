// Pure view-model mapping for the management UI: frozen V02-17 snapshot and
// history envelopes in, plain render-ready structures out. No DOM access and
// no network access, so the unit suite imports these directly from Node.
//
// The input shapes are exactly the frozen contracts (SchemaSnapshot,
// SchemaSnapshotTable, SchemaOperationRecord mapped snake_case over HTTP).
// Guards here are defence against a malformed envelope — they throw a plain
// Error that app.js renders as the generic error state; they never invent
// data.

function requireArray(value, what) {
  if (!Array.isArray(value)) {
    throw new Error(`Unexpected ${what}: expected a list`)
  }
  return value
}

function requireObject(value, what) {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Unexpected ${what}: expected an object`)
  }
  return value
}

/** One table row for the schema overview. */
export function summarizeTable(table) {
  const t = requireObject(table, "table")
  return {
    schema: String(t.schema),
    name: String(t.name),
    kind: String(t.kind),
    classification: String(t.classification),
    exposed: Boolean(t.exposure?.exposed),
    alias: t.exposure?.alias ?? null,
    rlsEnabled: Boolean(t.hasRowSecurity),
    rlsForced: Boolean(t.hasForcedRowSecurity),
    columnCount: Array.isArray(t.columns) ? t.columns.length : 0,
  }
}

/**
 * The full schema overview: one entry per schema, tables summarized, empty
 * schemas kept (the contract includes them deliberately).
 */
export function summarizeSnapshot(snapshot) {
  const s = requireObject(snapshot, "snapshot")
  const schemas = requireArray(s.schemas, "snapshot.schemas").map((schema) => {
    const entry = requireObject(schema, "schema")
    return {
      name: String(entry.name),
      owner: String(entry.owner),
      classification: String(entry.classification),
      tables: requireArray(entry.tables, "schema.tables").map(summarizeTable),
    }
  })
  const migrations = requireArray(s.migrations, "snapshot.migrations").map(
    (record) => {
      const m = requireObject(record, "migration")
      return {
        filename: String(m.filename),
        checksum: String(m.checksum),
        appliedAt: String(m.appliedAt),
      }
    },
  )
  return { schemas, migrations }
}

/** True when the snapshot has nothing to show in the overview. */
export function isEmptySnapshot(summary) {
  return (
    summary.schemas.length === 0 ||
    summary.schemas.every((schema) => schema.tables.length === 0)
  )
}

/** Full detail model for one table view. */
export function tableDetailModel(table) {
  const t = requireObject(table, "table")
  const columns = requireArray(t.columns, "table.columns").map((column) => {
    const c = requireObject(column, "column")
    return {
      ordinal: Number(c.ordinal),
      name: String(c.name),
      renderedType: String(c.renderedType),
      nullable: Boolean(c.isNullable),
      defaultExpression: c.defaultExpression ?? null,
      generated: String(c.generated),
      identity: String(c.identity),
    }
  })
  const constraints = requireArray(t.constraints, "table.constraints").map(
    (constraint) => {
      const c = requireObject(constraint, "constraint")
      return {
        name: String(c.name),
        classification: String(c.classification),
        columns: Array.isArray(c.columns) ? c.columns.map(String) : [],
        references: c.references ?? null,
        onUpdate: c.onUpdate ?? null,
        onDelete: c.onDelete ?? null,
      }
    },
  )
  const indexes = requireArray(t.indexes, "table.indexes").map((index) => {
    const i = requireObject(index, "index")
    return {
      name: String(i.name),
      classification: String(i.classification),
      isUnique: Boolean(i.isUnique),
      isExpression: Boolean(i.isExpression),
      hasPredicate: Boolean(i.hasPredicate),
      columns: Array.isArray(i.columns) ? i.columns : [],
    }
  })
  return {
    schema: String(t.schema),
    name: String(t.name),
    fullName: `${t.schema}.${t.name}`,
    owner: String(t.owner),
    kind: String(t.kind),
    classification: String(t.classification),
    exposed: Boolean(t.exposure?.exposed),
    alias: t.exposure?.alias ?? null,
    rlsEnabled: Boolean(t.hasRowSecurity),
    rlsForced: Boolean(t.hasForcedRowSecurity),
    columns,
    constraints,
    indexes,
  }
}

/** One history row for the history view. */
export function historyRecordModel(record) {
  const r = requireObject(record, "history record")
  return {
    id: Number(r.id),
    idempotencyKey: String(r.idempotency_key),
    commandType: String(r.command_type),
    status: String(r.status),
    errorCode: r.error_code ?? null,
    createdAt: String(r.created_at),
    finishedAt: r.finished_at ?? null,
  }
}

/** History view model: rows plus the pagination window actually shown. */
export function historyViewModel(listEnvelope) {
  const env = requireObject(listEnvelope, "history envelope")
  const rows = requireArray(env.data, "history.data").map(historyRecordModel)
  const meta = requireObject(env.meta, "history.meta")
  const limit = Number(meta.limit)
  const offset = Number(meta.offset)
  return {
    rows,
    limit,
    offset,
    hasPrevious: offset > 0,
    hasNext: rows.length === limit,
  }
}

// ---------------------------------------------------------------------------
// Mutation forms (I2, frozen V02-18 surface).
//
// The specs below are the single source of truth for the typed UI workflows:
// render.js draws the fields, app.js reads the values back, and the client
// methods in api.js send them. Client-side validation only mirrors the frozen
// server allowlists (types, default kinds, actions, templates) so an invalid
// body is caught before the network; the server remains the authority and
// its dry run is the mandatory preview before any real execution.
// ---------------------------------------------------------------------------

/** Frozen DDL column type allowlist (docs/admin-api.md). */
export const COLUMN_TYPES = Object.freeze([
  "text",
  "integer",
  "bigint",
  "boolean",
  "uuid",
  "timestamp",
  "timestamptz",
  "date",
  "numeric",
  "jsonb",
])

/** Frozen column default template kinds. */
export const DEFAULT_KINDS = Object.freeze([
  "none",
  "literal",
  "current_timestamp",
  "random_uuid",
])

/** Frozen foreign-key action allowlist (set_default has no representation). */
export const FOREIGN_KEY_ACTIONS = Object.freeze([
  "no_action",
  "restrict",
  "cascade",
  "set_null",
])

/** Frozen ownership policy template allowlist. */
export const POLICY_TEMPLATES = Object.freeze([
  "read",
  "insert",
  "update",
  "delete",
])

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/
const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

/**
 * One client-side idempotency key per form open. Dry runs never touch the
 * server's idempotency record (they always roll back), so the same key
 * graduates from dry run to real execution.
 */
export function newIdempotencyKey() {
  return `ui-${globalThis.crypto.randomUUID()}`
}

/**
 * Parse the literal default text box into the frozen JSON primitive model.
 * Quoted JSON strings, numbers, booleans and null parse as themselves; any
 * other input is sent verbatim as a string.
 */
export function parseLiteralDefault(text) {
  const trimmed = String(text).trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (
      parsed === null ||
      ["string", "number", "boolean"].includes(typeof parsed)
    ) {
      return parsed
    }
  } catch {
    // Not JSON: treat the box content as a plain string literal.
  }
  return trimmed
}

function defaultTemplate(
  values,
  kindKey = "default_kind",
  valueKey = "default_value",
) {
  const kind = values[kindKey]
  if (kind === "literal") {
    return {
      kind: "literal",
      value: parseLiteralDefault(values[valueKey] ?? ""),
    }
  }
  return { kind }
}

/** Field list shared by "create table" rows and "add column". */
function columnFields(prefix) {
  return [
    {
      name: `${prefix}name`,
      kind: "text",
      label: "Column name",
      required: true,
      hint: "Lowercase letters, digits, and underscores; may not be id.",
    },
    {
      name: `${prefix}type`,
      kind: "select",
      label: "Type",
      required: true,
      options: COLUMN_TYPES,
    },
    {
      name: `${prefix}nullable`,
      kind: "checkbox",
      label: "Nullable",
    },
    {
      name: `${prefix}default_kind`,
      kind: "select",
      label: "Default",
      required: true,
      options: DEFAULT_KINDS,
    },
    {
      name: `${prefix}default_value`,
      kind: "text",
      label: "Literal default (JSON)",
      placeholder: '"untitled", 42, true, null',
      hint: "Used only when Default is literal.",
      visibleWhen: (values) => values[`${prefix}default_kind`] === "literal",
    },
  ]
}

function validateColumnValues(values, prefix, errors) {
  const name = String(values[`${prefix}name`] ?? "").trim()
  if (!IDENTIFIER_PATTERN.test(name)) {
    errors.push(
      "Column name must be 1-63 characters: a-z, 0-9, underscore, not starting with a digit.",
    )
  }
  if (name === "id") {
    errors.push("Operator columns may not use the managed name id.")
  }
  if (!COLUMN_TYPES.includes(values[`${prefix}type`])) {
    errors.push("Column type must come from the frozen allowlist.")
  }
  const kind = values[`${prefix}default_kind`]
  if (!DEFAULT_KINDS.includes(kind)) {
    errors.push("Default must come from the frozen template kinds.")
  }
  if (
    kind === "current_timestamp" &&
    !["timestamp", "timestamptz"].includes(values[`${prefix}type`])
  ) {
    errors.push(
      "current_timestamp defaults only compile on timestamp and timestamptz columns.",
    )
  }
  if (kind === "random_uuid" && values[`${prefix}type`] !== "uuid") {
    errors.push("random_uuid defaults only compile on uuid columns.")
  }
}

/**
 * The registry of typed mutation forms. ctx carries the target identity:
 * { schema, table?, column?, model? } where model is the table detail model
 * (column lists); table.create uses { schemaNames } instead.
 */
export const MUTATION_SPECS = Object.freeze({
  "table.create": {
    id: "table.create",
    method: "createTable",
    destructive: false,
    heading: (ctx) => `Create table in ${ctx.schema}`,
    description: () =>
      "Creates a managed table: the id uuid primary key is appended automatically, and operator columns may not be named id.",
    initialValues: () => ({
      schema: "",
      table: "",
      columns: [
        {
          name: "",
          type: "text",
          nullable: false,
          default_kind: "none",
          default_value: "",
        },
      ],
    }),
    columnRowFields: columnFields(""),
    validate(values, errors) {
      if (!IDENTIFIER_PATTERN.test(String(values.schema ?? "").trim())) {
        errors.push("Schema must be a simple identifier from the snapshot.")
      }
      if (!IDENTIFIER_PATTERN.test(String(values.table ?? "").trim())) {
        errors.push(
          "Table name must be 1-63 characters: a-z, 0-9, underscore, not starting with a digit.",
        )
      }
      if (!Array.isArray(values.columns) || values.columns.length < 1) {
        errors.push("At least one operator column is required.")
      }
      const names = new Set()
      for (const column of values.columns) {
        validateColumnValues(column, "", errors)
        const name = String(column.name ?? "").trim()
        if (names.has(name)) {
          errors.push(`Duplicate column name ${name}.`)
        }
        names.add(name)
      }
    },
    buildInput(values) {
      return {
        schema: String(values.schema).trim(),
        table: String(values.table).trim(),
        columns: values.columns.map((column) => ({
          name: String(column.name).trim(),
          type: column.type,
          nullable: column.nullable === true,
          default: defaultTemplate(column),
        })),
      }
    },
    summarize: (values) =>
      `Create table ${String(values.schema).trim()}.${String(values.table).trim()} with ${values.columns.length} operator column(s).`,
  },

  "table.rename": {
    id: "table.rename",
    method: "renameTable",
    destructive: false,
    heading: (ctx) => `Rename table ${ctx.schema}.${ctx.table}`,
    description: () =>
      "Renames the table; constraints, indexes, and exposure move with it.",
    initialValues: () => ({ new_name: "" }),
    fields: [
      {
        name: "new_name",
        kind: "text",
        label: "New table name",
        required: true,
        hint: "1-63 characters: a-z, 0-9, underscore, not starting with a digit.",
      },
    ],
    validate(values, errors, ctx) {
      const name = String(values.new_name ?? "").trim()
      if (!IDENTIFIER_PATTERN.test(name)) {
        errors.push(
          "New table name must be 1-63 characters: a-z, 0-9, underscore, not starting with a digit.",
        )
      } else if (name === ctx.table) {
        errors.push("The new name must differ from the current table name.")
      }
    },
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      newName: String(values.new_name).trim(),
    }),
    summarize: (values, ctx) =>
      `Rename table ${ctx.schema}.${ctx.table} to ${String(values.new_name).trim()}.`,
  },

  "table.drop": {
    id: "table.drop",
    method: "dropTable",
    destructive: true,
    heading: (ctx) => `Drop table ${ctx.schema}.${ctx.table}`,
    description: () =>
      "Permanently drops the table and every row in it. Refuses exposed tables and tables referenced by another table's foreign key.",
    confirmLabel: "Type the exact table name to confirm",
    confirmValue: (ctx) => `${ctx.schema}.${ctx.table}`,
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      confirm: values.confirm,
    }),
    summarize: (values, ctx) =>
      `Drop table ${ctx.schema}.${ctx.table} permanently.`,
  },

  "column.add": {
    id: "column.add",
    method: "addColumn",
    destructive: false,
    heading: (ctx) => `Add column to ${ctx.schema}.${ctx.table}`,
    description: () => "Adds one typed column with a frozen default template.",
    initialValues: () => ({
      name: "",
      type: "text",
      nullable: true,
      default_kind: "none",
      default_value: "",
    }),
    fields: columnFields(""),
    validate(values, errors) {
      validateColumnValues(values, "", errors)
    },
    buildInput(values, ctx) {
      return {
        schema: ctx.schema,
        table: ctx.table,
        column: {
          name: String(values.name).trim(),
          type: values.type,
          nullable: values.nullable === true,
          default: defaultTemplate(values),
        },
      }
    },
    summarize: (values, ctx) =>
      `Add column ${String(values.name).trim()} (${values.type}) to ${ctx.schema}.${ctx.table}.`,
  },

  "column.rename": {
    id: "column.rename",
    method: "renameColumn",
    destructive: false,
    heading: (ctx) => `Rename column ${ctx.column}`,
    description: (ctx) => `Renames the column on ${ctx.schema}.${ctx.table}.`,
    initialValues: () => ({ new_name: "" }),
    fields: [
      {
        name: "new_name",
        kind: "text",
        label: "New column name",
        required: true,
      },
    ],
    validate(values, errors, ctx) {
      const name = String(values.new_name ?? "").trim()
      if (!IDENTIFIER_PATTERN.test(name)) {
        errors.push(
          "New column name must be 1-63 characters: a-z, 0-9, underscore, not starting with a digit.",
        )
      } else if (name === ctx.column) {
        errors.push("The new name must differ from the current column name.")
      }
    },
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      column: ctx.column,
      newName: String(values.new_name).trim(),
    }),
    summarize: (values, ctx) =>
      `Rename column ${ctx.column} to ${String(values.new_name).trim()} on ${ctx.schema}.${ctx.table}.`,
  },

  "column.drop": {
    id: "column.drop",
    method: "dropColumn",
    destructive: true,
    heading: (ctx) => `Drop column ${ctx.column}`,
    description: (ctx) =>
      `Permanently drops the column and every value in it from ${ctx.schema}.${ctx.table}.`,
    confirmLabel: "Type the exact column path to confirm",
    confirmValue: (ctx) => `${ctx.schema}.${ctx.table}.${ctx.column}`,
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      column: ctx.column,
      confirm: values.confirm,
    }),
    summarize: (values, ctx) =>
      `Drop column ${ctx.column} from ${ctx.schema}.${ctx.table} permanently.`,
  },

  "column.default.set": {
    id: "column.default.set",
    method: "setColumnDefault",
    destructive: false,
    heading: (ctx) => `Set default on ${ctx.column}`,
    description: () =>
      "Replaces the column default with a frozen template; existing rows keep their values.",
    initialValues: () => ({ default_kind: "none", default_value: "" }),
    fields: columnFields("").filter((field) =>
      ["default_kind", "default_value"].includes(field.name),
    ),
    validate(values, errors, ctx) {
      const column = ctx.model.columns.find(
        (entry) => entry.name === ctx.column,
      )
      const kind = values.default_kind
      if (!DEFAULT_KINDS.includes(kind)) {
        errors.push("Default must come from the frozen template kinds.")
      }
      if (
        kind === "current_timestamp" &&
        column !== undefined &&
        !["timestamp", "timestamptz"].includes(column.renderedType)
      ) {
        errors.push(
          "current_timestamp defaults only compile on timestamp and timestamptz columns.",
        )
      }
      if (
        kind === "random_uuid" &&
        column !== undefined &&
        column.renderedType !== "uuid"
      ) {
        errors.push("random_uuid defaults only compile on uuid columns.")
      }
    },
    buildInput(values, ctx) {
      return {
        schema: ctx.schema,
        table: ctx.table,
        column: ctx.column,
        default: defaultTemplate(values),
      }
    },
    summarize: (values, ctx) =>
      `Set the default of ${ctx.schema}.${ctx.table}.${ctx.column} to ${values.default_kind}.`,
  },

  "column.default.drop": {
    id: "column.default.drop",
    method: "dropColumnDefault",
    destructive: false,
    heading: (ctx) => `Drop default on ${ctx.column}`,
    description: () =>
      "Removes the column default; existing rows keep their values.",
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      column: ctx.column,
    }),
    summarize: (values, ctx) =>
      `Drop the default of ${ctx.schema}.${ctx.table}.${ctx.column}.`,
  },

  "column.not_null.set": {
    id: "column.not_null.set",
    method: "setColumnNotNull",
    destructive: false,
    heading: (ctx) => `Set not null on ${ctx.column}`,
    description: () =>
      "Rejects null values from now on; fails when existing rows hold null.",
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      column: ctx.column,
    }),
    summarize: (values, ctx) =>
      `Set ${ctx.schema}.${ctx.table}.${ctx.column} to NOT NULL.`,
  },

  "column.nullable": {
    id: "column.nullable",
    method: "setColumnNullable",
    destructive: false,
    heading: (ctx) => `Allow null on ${ctx.column}`,
    description: () => "Allows null values in the column.",
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      column: ctx.column,
    }),
    summarize: (values, ctx) =>
      `Allow null in ${ctx.schema}.${ctx.table}.${ctx.column}.`,
  },

  "column.type.change": {
    id: "column.type.change",
    method: "changeColumnType",
    destructive: false,
    heading: (ctx) => `Change type of ${ctx.column}`,
    description: () =>
      "Only the frozen safe-conversion matrix compiles: integer to bigint or numeric, bigint to numeric, date to timestamp. Anything else is refused.",
    initialValues: () => ({ to_type: "" }),
    fields: [
      {
        name: "to_type",
        kind: "select",
        label: "New type",
        required: true,
        options: COLUMN_TYPES,
        placeholder: "Choose the target type",
      },
    ],
    validate(values, errors) {
      if (!COLUMN_TYPES.includes(values.to_type)) {
        errors.push("Target type must come from the frozen allowlist.")
      }
    },
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      column: ctx.column,
      toType: values.to_type,
    }),
    summarize: (values, ctx) =>
      `Change the type of ${ctx.schema}.${ctx.table}.${ctx.column} to ${values.to_type}.`,
  },

  "index.create": {
    id: "index.create",
    method: "createIndex",
    destructive: false,
    heading: (ctx) => `Create index on ${ctx.schema}.${ctx.table}`,
    description: () =>
      "Creates a plain non-unique index over the chosen columns.",
    initialValues: () => ({ columns: [], name: "" }),
    fields: [
      {
        name: "columns",
        kind: "columnPicker",
        label: "Indexed columns",
        required: true,
      },
      {
        name: "name",
        kind: "text",
        label: "Index name (optional)",
        hint: "Generated deterministically when left empty.",
      },
    ],
    validate(values, errors, ctx) {
      requirePickedColumns(values, ctx, errors)
    },
    buildInput(values, ctx) {
      return {
        schema: ctx.schema,
        table: ctx.table,
        columns: values.columns,
        ...(String(values.name ?? "").trim() === ""
          ? {}
          : { name: String(values.name).trim() }),
      }
    },
    summarize: (values, ctx) =>
      `Create an index on ${ctx.schema}.${ctx.table} over (${values.columns.join(", ")}).`,
  },

  "index.drop": {
    id: "index.drop",
    method: "dropIndex",
    destructive: false,
    heading: (ctx) => `Drop index ${ctx.name}`,
    description: (ctx) =>
      `Drops the standalone index from ${ctx.schema}.${ctx.table}. Constraint-backed indexes drop with their constraint.`,
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      name: ctx.name,
    }),
    summarize: (values, ctx) =>
      `Drop index ${ctx.name} from ${ctx.schema}.${ctx.table}.`,
  },

  "unique.add": {
    id: "unique.add",
    method: "addUniqueConstraint",
    destructive: false,
    heading: (ctx) => `Add unique constraint to ${ctx.schema}.${ctx.table}`,
    description: () => "Adds a unique constraint over the chosen columns.",
    initialValues: () => ({ columns: [], name: "" }),
    fields: [
      {
        name: "columns",
        kind: "columnPicker",
        label: "Constrained columns",
        required: true,
      },
      {
        name: "name",
        kind: "text",
        label: "Constraint name (optional)",
        hint: "Generated deterministically when left empty.",
      },
    ],
    validate(values, errors, ctx) {
      requirePickedColumns(values, ctx, errors)
    },
    buildInput(values, ctx) {
      return {
        schema: ctx.schema,
        table: ctx.table,
        columns: values.columns,
        ...(String(values.name ?? "").trim() === ""
          ? {}
          : { name: String(values.name).trim() }),
      }
    },
    summarize: (values, ctx) =>
      `Add a unique constraint on ${ctx.schema}.${ctx.table} over (${values.columns.join(", ")}).`,
  },

  "constraint.drop": {
    id: "constraint.drop",
    method: "dropConstraint",
    destructive: false,
    heading: (ctx) => `Drop constraint ${ctx.name}`,
    description: () =>
      "Drops a unique or foreign-key constraint. Primary-key, check, and exclusion constraints are never manageable and refuse here.",
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      name: ctx.name,
    }),
    summarize: (values, ctx) =>
      `Drop constraint ${ctx.name} from ${ctx.schema}.${ctx.table}.`,
  },

  "fk.add": {
    id: "fk.add",
    method: "addForeignKey",
    destructive: false,
    heading: (ctx) => `Add foreign key to ${ctx.schema}.${ctx.table}`,
    description: () =>
      "Adds a foreign key over local columns to a referenced table. Actions are the frozen allowlist; SET NULL compiles only on nullable referencing columns.",
    initialValues: () => ({
      columns: [],
      ref_schema: "",
      ref_table: "",
      ref_columns: "id",
      on_update: "no_action",
      on_delete: "no_action",
      name: "",
    }),
    fields: [
      {
        name: "columns",
        kind: "columnPicker",
        label: "Referencing columns",
        required: true,
      },
      {
        name: "ref_schema",
        kind: "text",
        label: "Referenced schema",
        required: true,
      },
      {
        name: "ref_table",
        kind: "text",
        label: "Referenced table",
        required: true,
      },
      {
        name: "ref_columns",
        kind: "text",
        label: "Referenced columns (comma-separated)",
        required: true,
        hint: "Defaults to the referenced table's id column.",
      },
      {
        name: "on_update",
        kind: "select",
        label: "ON UPDATE",
        required: true,
        options: FOREIGN_KEY_ACTIONS,
      },
      {
        name: "on_delete",
        kind: "select",
        label: "ON DELETE",
        required: true,
        options: FOREIGN_KEY_ACTIONS,
      },
      {
        name: "name",
        kind: "text",
        label: "Constraint name (optional)",
        hint: "Generated deterministically when left empty.",
      },
    ],
    validate(values, errors, ctx) {
      requirePickedColumns(values, ctx, errors)
      for (const key of ["ref_schema", "ref_table"]) {
        if (!IDENTIFIER_PATTERN.test(String(values[key] ?? "").trim())) {
          errors.push("Referenced schema and table must be simple identifiers.")
          break
        }
      }
      const referenced = String(values.ref_columns ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
      if (referenced.length < 1) {
        errors.push("At least one referenced column is required.")
      }
      if (
        (values.on_update === "set_null" || values.on_delete === "set_null") &&
        ctx.model !== undefined
      ) {
        const nullable = values.columns.every((name) => {
          const column = ctx.model.columns.find((entry) => entry.name === name)
          return column !== undefined && column.nullable
        })
        if (!nullable) {
          errors.push(
            "SET NULL compiles only when every referencing column is nullable.",
          )
        }
      }
    },
    buildInput(values, ctx) {
      return {
        schema: ctx.schema,
        table: ctx.table,
        columns: values.columns,
        references: {
          schema: String(values.ref_schema).trim(),
          table: String(values.ref_table).trim(),
          columns: String(values.ref_columns)
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry !== ""),
        },
        onUpdate: values.on_update,
        onDelete: values.on_delete,
        ...(String(values.name ?? "").trim() === ""
          ? {}
          : { name: String(values.name).trim() }),
      }
    },
    summarize: (values, ctx) =>
      `Add a foreign key on ${ctx.schema}.${ctx.table} (${values.columns.join(", ")}) referencing ${String(values.ref_schema).trim()}.${String(values.ref_table).trim()}.`,
  },

  "exposure.expose": {
    id: "exposure.expose",
    method: "expose",
    destructive: false,
    heading: (ctx) => `Expose ${ctx.schema}.${ctx.table}`,
    description: (ctx) =>
      `Publishes the table at the data API under an alias. Requires the managed id uuid primary key, row security enabled and forced, and the module-owned ownership policies for every data-API command. ` +
      (ctx.model !== undefined && ctx.model.rlsEnabled
        ? "Row security is enabled on this table."
        : "Row security is not enabled on this table yet: enable it and add the ownership policies first."),
    initialValues: () => ({ alias: "" }),
    fields: [
      {
        name: "alias",
        kind: "text",
        label: "Data API alias",
        required: true,
        hint: "Lowercase letters, digits, and underscores; reachable at /v1/data/<alias> after a successful expose.",
      },
    ],
    validate(values, errors) {
      if (!ALIAS_PATTERN.test(String(values.alias ?? "").trim())) {
        errors.push(
          "Alias must be 1-63 characters: a-z, 0-9, underscore, not starting with a digit.",
        )
      }
    },
    buildInput(values, ctx) {
      return {
        schema: ctx.schema,
        table: ctx.table,
        alias: String(values.alias).trim(),
      }
    },
    summarize: (values, ctx) =>
      `Expose ${ctx.schema}.${ctx.table} at the data API as ${String(values.alias).trim()}.`,
  },

  "exposure.unexpose": {
    id: "exposure.unexpose",
    method: "unexpose",
    destructive: false,
    heading: (ctx) => `Unexpose ${ctx.schema}.${ctx.table}`,
    description: () =>
      "Removes the data API alias and revokes the least-privilege runtime grants. Structural changes become available again afterwards.",
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
    }),
    summarize: (values, ctx) =>
      `Unexpose ${ctx.schema}.${ctx.table} from the data API.`,
  },

  "rls.enable": {
    id: "rls.enable",
    method: "enableRls",
    destructive: false,
    heading: (ctx) => `Enable row security on ${ctx.schema}.${ctx.table}`,
    description: () =>
      "Enables row-level security and forces it for the table owner in one change.",
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
    }),
    summarize: (values, ctx) =>
      `Enable and force row security on ${ctx.schema}.${ctx.table}.`,
  },

  "rls.disable": {
    id: "rls.disable",
    method: "disableRls",
    destructive: true,
    heading: (ctx) => `Disable row security on ${ctx.schema}.${ctx.table}`,
    description: () =>
      "Disables row-level security for every role. Refuses while the table is exposed to the data API.",
    confirmLabel: "Type the exact table name to confirm",
    confirmValue: (ctx) => `${ctx.schema}.${ctx.table}`,
    initialValues: () => ({}),
    fields: [],
    validate() {},
    buildInput: (values, ctx) => ({
      schema: ctx.schema,
      table: ctx.table,
      confirm: values.confirm,
    }),
    summarize: (values, ctx) =>
      `Disable row security on ${ctx.schema}.${ctx.table}.`,
  },

  "policy.create": {
    id: "policy.create",
    method: "createPolicy",
    destructive: false,
    heading: (ctx) => `Add ownership policy to ${ctx.schema}.${ctx.table}`,
    description: () =>
      "Binds one ownership template (read, insert, update, delete) to a uuid ownership column over the transaction-local user identity.",
    initialValues: () => ({ policy_column: "", policy_template: "read" }),
    fields: [
      {
        name: "policy_column",
        kind: "uuidColumnPicker",
        label: "Ownership column",
        required: true,
      },
      {
        name: "policy_template",
        kind: "select",
        label: "Template",
        required: true,
        options: POLICY_TEMPLATES,
      },
    ],
    validate(values, errors) {
      if (!POLICY_TEMPLATES.includes(values.policy_template)) {
        errors.push("Template must come from the frozen allowlist.")
      }
      if (String(values.policy_column ?? "").trim() === "") {
        errors.push("Choose the uuid ownership column.")
      }
    },
    buildInput(values, ctx) {
      return {
        schema: ctx.schema,
        table: ctx.table,
        column: String(values.policy_column).trim(),
        template: values.policy_template,
      }
    },
    summarize: (values, ctx) =>
      `Add the ${values.policy_template} ownership policy on ${ctx.schema}.${ctx.table} over ${String(values.policy_column).trim()}.`,
  },

  "policy.remove": {
    id: "policy.remove",
    method: "removePolicy",
    destructive: false,
    heading: (ctx) => `Remove ownership policy from ${ctx.schema}.${ctx.table}`,
    description: () => "Removes one module-owned ownership policy template.",
    initialValues: () => ({ policy_column: "", policy_template: "read" }),
    fields: [
      {
        name: "policy_column",
        kind: "uuidColumnPicker",
        label: "Ownership column",
        required: true,
      },
      {
        name: "policy_template",
        kind: "select",
        label: "Template",
        required: true,
        options: POLICY_TEMPLATES,
      },
    ],
    validate(values, errors) {
      if (!POLICY_TEMPLATES.includes(values.policy_template)) {
        errors.push("Template must come from the frozen allowlist.")
      }
      if (String(values.policy_column ?? "").trim() === "") {
        errors.push("Choose the uuid ownership column.")
      }
    },
    buildInput(values, ctx) {
      return {
        schema: ctx.schema,
        table: ctx.table,
        column: String(values.policy_column).trim(),
        template: values.policy_template,
      }
    },
    summarize: (values, ctx) =>
      `Remove the ${values.policy_template} ownership policy on ${ctx.schema}.${ctx.table} over ${String(values.policy_column).trim()}.`,
  },
})

function requirePickedColumns(values, ctx, errors) {
  if (!Array.isArray(values.columns) || values.columns.length < 1) {
    errors.push("Choose at least one column.")
    return
  }
  const known = new Set((ctx.model?.columns ?? []).map((column) => column.name))
  for (const name of values.columns) {
    if (!known.has(name)) {
      errors.push(`Unknown column ${name}.`)
    }
  }
}

/** A spec's human title for buttons and headings. */
export function mutationSpec(id) {
  const spec = MUTATION_SPECS[id]
  if (spec === undefined) {
    throw new Error(`Unknown mutation form ${id}`)
  }
  return spec
}
