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
