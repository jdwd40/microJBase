// Read-only PostgreSQL schema-catalogue reader for microJBase v0.2 (V02-01,
// extended by V02-02 with constraint and index metadata).
//
// The reader executes exactly one fixed, read-only catalogue SELECT statement
// against pg_namespace/pg_class/pg_attribute/pg_type/pg_attrdef,
// pg_constraint, and pg_index. No caller identifier or SQL fragment ever
// enters the query text; quoted or hostile-looking schema/table/column/
// constraint/index names are returned as data only. There is no mutation
// path: the reader issues one SELECT and maps rows.
//
// One statement means one snapshot: a single SELECT runs under a single
// PostgreSQL snapshot, so concurrent DDL cannot stitch together a
// well-typed catalogue state that never existed across round trips. The
// statement pins search_path to pg_catalog transaction-locally (via
// pg_catalog.set_config inside the statement), so format_type/pg_get_expr
// renderings are deterministic regardless of the caller's search_path.
//
// The pin is a real SQL-semantic barrier, not a planner coincidence: a
// MATERIALIZED CTE executes pg_catalog.set_config exactly once before the
// outer query, and the catalogue UNION renders inside a LATERAL subquery
// that carries an outer reference (pin.pinned_path) into every branch, so
// the rendering cannot execute until the pin has. The pin is
// transaction-local, so pooled sessions are never mutated.
//
// The query capability is injected by the caller; this module never
// constructs a production pool. V02-04 introduces the schema-admin
// connection boundary that will inject it in production.

import type pg from "pg"

import type {
  ColumnGeneratedKind,
  ColumnIdentityKind,
  ConstraintClassification,
  ForeignKeyAction,
  IndexClassification,
  SchemaCatalogue,
  SchemaCatalogueColumn,
  SchemaCatalogueReader,
  SchemaCatalogueSchema,
  SchemaCatalogueTable,
  SchemaConstraint,
  SchemaIndex,
  SchemaTableKind,
  TypeIdentity,
} from "../contracts/index.js"
import { AppError } from "../core/index.js"

import { translatePoolError } from "./pool.js"

/**
 * Injected query capability. Structurally identical to the query surface
 * used by the existing database adapters, so a Pool, PoolClient, or test
 * double can be supplied directly.
 */
export interface SchemaCatalogueDependencies {
  query: <R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<R>>
}

// Single fixed read-only catalogue statement. Three row kinds (schema,
// table, column) are returned together and tagged by row_kind; columns not
// meaningful for a kind are NULL. Exported for unit tests that pin the
// query shape; not part of the public module surface.
//
// The statement opens with a MATERIALIZED search_path_pin CTE so
// pg_catalog.set_config runs exactly once before the outer query, and the
// catalogue UNION renders inside a LATERAL subquery that references
// pin.pinned_path in every branch. The LATERAL outer reference is what
// makes the pin an evaluation barrier: the UNION cannot execute until the
// pin CTE has produced its row. pinned_path is data-flow only and is never
// projected into the catalogue rows.
export const SCHEMA_CATALOGUE_SQL = `WITH search_path_pin AS MATERIALIZED (
  SELECT pg_catalog.set_config('search_path', 'pg_catalog', true) AS pinned_path
)
SELECT r.row_kind,
       r.schema_name,
       r.table_name,
       r.ordinal,
       r.name,
       r.owner,
       r.kind,
       r.has_row_security,
       r.has_forced_row_security,
       r.is_nullable,
       r.default_expression,
       r.generated,
       r.identity,
       r.rendered_type,
       r.type_schema,
       r.type_name,
       r.type_kind,
       r.base_type_schema,
       r.base_type_name,
       r.base_type_kind,
       r.constraint_type,
       r.constraint_columns,
       r.ref_schema,
       r.ref_table,
       r.ref_columns,
       r.on_update,
       r.on_delete,
       r.is_unique,
       r.is_expression,
       r.has_predicate,
       r.index_columns
FROM search_path_pin pin
CROSS JOIN LATERAL (
  SELECT 'schema' AS row_kind,
         n.nspname AS schema_name,
         NULL::text AS table_name,
         NULL::integer AS ordinal,
         NULL::text AS name,
         pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
         NULL::text AS kind,
         NULL::boolean AS has_row_security,
         NULL::boolean AS has_forced_row_security,
         NULL::boolean AS is_nullable,
         NULL::text AS default_expression,
         NULL::text AS generated,
         NULL::text AS identity,
         NULL::text AS rendered_type,
         NULL::text AS type_schema,
         NULL::text AS type_name,
         NULL::text AS type_kind,
         NULL::text AS base_type_schema,
         NULL::text AS base_type_name,
         NULL::text AS base_type_kind,
         NULL::text AS constraint_type,
         NULL::text[] AS constraint_columns,
         NULL::text AS ref_schema,
         NULL::text AS ref_table,
         NULL::text[] AS ref_columns,
         NULL::text AS on_update,
         NULL::text AS on_delete,
         NULL::boolean AS is_unique,
         NULL::boolean AS is_expression,
         NULL::boolean AS has_predicate,
         NULL::text[] AS index_columns,
         pin.pinned_path
  FROM pg_catalog.pg_namespace n
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\\_%'
  UNION ALL
  SELECT 'table',
         n.nspname,
         c.relname,
         NULL::integer,
         NULL::text,
         pg_catalog.pg_get_userbyid(c.relowner),
         CASE c.relkind WHEN 'p' THEN 'partitioned' ELSE 'regular' END,
         c.relrowsecurity,
         c.relforcerowsecurity,
         NULL::boolean,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text[],
         NULL::text,
         NULL::text,
         NULL::text[],
         NULL::text,
         NULL::text,
         NULL::boolean,
         NULL::boolean,
         NULL::boolean,
         NULL::text[],
         pin.pinned_path
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\\_%'
  UNION ALL
  SELECT 'column',
         n.nspname,
         c.relname,
         a.attnum,
         a.attname,
         NULL::text,
         NULL::text,
         NULL::boolean,
         NULL::boolean,
         (NOT a.attnotnull),
         pg_catalog.pg_get_expr(d.adbin, d.adrelid),
         a.attgenerated::text,
         a.attidentity::text,
         pg_catalog.format_type(a.atttypid, a.atttypmod),
         tn.nspname,
         ty.typname,
         ty.typtype::text,
         bn.nspname,
         bt.typname,
         bt.typtype::text,
         NULL::text,
         NULL::text[],
         NULL::text,
         NULL::text,
         NULL::text[],
         NULL::text,
         NULL::text,
         NULL::boolean,
         NULL::boolean,
         NULL::boolean,
         NULL::text[],
         pin.pinned_path
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = ty.typnamespace
  LEFT JOIN pg_catalog.pg_type bt ON bt.oid = ty.typbasetype
  LEFT JOIN pg_catalog.pg_namespace bn ON bn.oid = bt.typnamespace
  WHERE a.attnum > 0
    AND NOT a.attisdropped
    AND c.relkind IN ('r', 'p')
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\\_%'
  UNION ALL
  SELECT 'constraint',
         n.nspname,
         c.relname,
         NULL::integer,
         con.conname,
         NULL::text,
         NULL::text,
         NULL::boolean,
         NULL::boolean,
         NULL::boolean,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         con.contype::text,
         CASE WHEN con.contype <> 'c' THEN
           (SELECT array_agg(a.attname ORDER BY u.ord)
            FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_catalog.pg_attribute a
              ON a.attrelid = con.conrelid AND a.attnum = u.attnum)
         END,
         CASE WHEN con.contype = 'f' THEN rn.nspname END,
         CASE WHEN con.contype = 'f' THEN rc.relname END,
         CASE WHEN con.contype = 'f' THEN
           (SELECT array_agg(ra.attname ORDER BY u.ord)
            FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_catalog.pg_attribute ra
              ON ra.attrelid = con.confrelid AND ra.attnum = u.attnum)
         END,
         CASE WHEN con.contype = 'f' THEN con.confupdtype::text END,
         CASE WHEN con.contype = 'f' THEN con.confdeltype::text END,
         NULL::boolean,
         NULL::boolean,
         NULL::boolean,
         NULL::text[],
         pin.pinned_path
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
  LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\\_%'
    -- NOT NULL constraints (contype 'n', PostgreSQL 18+) are intentionally
    -- excluded: nullability is already reported per column via attnotnull,
    -- and excluding them keeps output identical on PostgreSQL 16 CI.
    AND con.contype IN ('p', 'u', 'f', 'c', 'x')
  UNION ALL
  SELECT 'index',
         n.nspname,
         t.relname,
         NULL::integer,
         ic.relname,
         NULL::text,
         NULL::text,
         NULL::boolean,
         NULL::boolean,
         NULL::boolean,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text[],
         NULL::text,
         NULL::text,
         NULL::text[],
         NULL::text,
         NULL::text,
         i.indisunique,
         (i.indexprs IS NOT NULL),
         (i.indpred IS NOT NULL),
         (SELECT array_agg(
                   CASE WHEN u.attnum = 0 THEN NULL ELSE a.attname END
                   ORDER BY u.ord)
          FROM (SELECT x.attnum::integer AS attnum, x.ord AS ord
                FROM unnest(string_to_array(i.indkey::text, ' '))
                     WITH ORDINALITY AS x(attnum, ord)) u
          LEFT JOIN pg_catalog.pg_attribute a
            ON a.attrelid = t.oid AND a.attnum = u.attnum),
         pin.pinned_path
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  LEFT JOIN pg_catalog.pg_constraint con ON con.conindid = i.indexrelid
  WHERE t.relkind IN ('r', 'p')
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\\_%'
    AND con.oid IS NULL
) r
ORDER BY r.row_kind, r.schema_name, r.table_name, r.ordinal, r.name`

// Raw unified catalogue row shape as returned by the fixed query. Every row
// carries all columns; fields not meaningful for its row_kind are NULL.
// Exported for the unit tests; not part of the public module surface.
export interface SchemaCatalogueRow {
  row_kind: unknown
  schema_name: unknown
  table_name: unknown
  ordinal: unknown
  name: unknown
  owner: unknown
  kind: unknown
  has_row_security: unknown
  has_forced_row_security: unknown
  is_nullable: unknown
  default_expression: unknown
  generated: unknown
  identity: unknown
  rendered_type: unknown
  type_schema: unknown
  type_name: unknown
  type_kind: unknown
  base_type_schema: unknown
  base_type_name: unknown
  base_type_kind: unknown
  constraint_type: unknown
  constraint_columns: unknown
  ref_schema: unknown
  ref_table: unknown
  ref_columns: unknown
  on_update: unknown
  on_delete: unknown
  is_unique: unknown
  is_expression: unknown
  has_predicate: unknown
  index_columns: unknown
}

// Fields that must be NULL for each row kind. mapSchemaCatalogue enforces
// these before building any model object, so a malformed or mismatched row
// fails closed instead of leaking into the catalogue.
const CONSTRAINT_INDEX_ROW_FIELDS = [
  "constraint_type",
  "constraint_columns",
  "ref_schema",
  "ref_table",
  "ref_columns",
  "on_update",
  "on_delete",
  "is_unique",
  "is_expression",
  "has_predicate",
  "index_columns",
] as const

const SCHEMA_ROW_NULL_FIELDS = [
  "table_name",
  "ordinal",
  "name",
  "kind",
  "has_row_security",
  "has_forced_row_security",
  "is_nullable",
  "default_expression",
  "generated",
  "identity",
  "rendered_type",
  "type_schema",
  "type_name",
  "type_kind",
  "base_type_schema",
  "base_type_name",
  "base_type_kind",
  ...CONSTRAINT_INDEX_ROW_FIELDS,
] as const

const TABLE_ROW_NULL_FIELDS = [
  "ordinal",
  "name",
  "is_nullable",
  "default_expression",
  "generated",
  "identity",
  "rendered_type",
  "type_schema",
  "type_name",
  "type_kind",
  "base_type_schema",
  "base_type_name",
  "base_type_kind",
  ...CONSTRAINT_INDEX_ROW_FIELDS,
] as const

const COLUMN_ROW_NULL_FIELDS = [
  "owner",
  "kind",
  "has_row_security",
  "has_forced_row_security",
  ...CONSTRAINT_INDEX_ROW_FIELDS,
] as const

// Constraint rows reuse the shared table locator (schema_name, table_name,
// name) and carry constraint fields; every table-, column-, and index-owned
// field must be NULL.
const CONSTRAINT_ROW_NULL_FIELDS = [
  "ordinal",
  "owner",
  "kind",
  "has_row_security",
  "has_forced_row_security",
  "is_nullable",
  "default_expression",
  "generated",
  "identity",
  "rendered_type",
  "type_schema",
  "type_name",
  "type_kind",
  "base_type_schema",
  "base_type_name",
  "base_type_kind",
  "is_unique",
  "is_expression",
  "has_predicate",
  "index_columns",
] as const

// Index rows reuse the same shared locator; every table-, column-, and
// constraint-owned field must be NULL.
const INDEX_ROW_NULL_FIELDS = [
  "ordinal",
  "owner",
  "kind",
  "has_row_security",
  "has_forced_row_security",
  "is_nullable",
  "default_expression",
  "generated",
  "identity",
  "rendered_type",
  "type_schema",
  "type_name",
  "type_kind",
  "base_type_schema",
  "base_type_name",
  "base_type_kind",
  "constraint_type",
  "constraint_columns",
  "ref_schema",
  "ref_table",
  "ref_columns",
  "on_update",
  "on_delete",
] as const

function malformed(reason: string): AppError {
  return new AppError(
    "INTERNAL_ERROR",
    `Malformed schema catalogue row: ${reason}`,
    500,
  )
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(`${field} must be a non-empty string`)
  }
  return value
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw malformed(`${field} must be a boolean`)
  }
  return value
}

function requireNull(value: unknown, field: string): null {
  if (value !== null) {
    throw malformed(`${field} must be null`)
  }
  return null
}

function requireOrdinal(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw malformed("ordinal must be a positive integer")
  }
  return value
}

function mapTypeKind(value: unknown, field: string): TypeIdentity["kind"] {
  switch (value) {
    case "b":
      return "base"
    case "d":
      return "domain"
    case "e":
      return "enum"
    case "r":
      return "range"
    case "m":
      return "multirange"
    case "c":
      return "composite"
    case "p":
      return "pseudo"
    default:
      throw malformed(`${field} has unsupported type kind`)
  }
}

function mapTableKind(value: unknown): SchemaTableKind {
  if (value === "regular" || value === "partitioned") {
    return value
  }
  throw malformed("kind must be regular or partitioned")
}

function mapGenerated(value: unknown): ColumnGeneratedKind {
  if (value === "") {
    return "none"
  }
  if (value === "s") {
    return "stored"
  }
  if (value === "v") {
    return "virtual"
  }
  throw malformed("generated must be empty, 's', or 'v'")
}

function mapIdentity(value: unknown): ColumnIdentityKind {
  if (value === "") {
    return "none"
  }
  if (value === "a") {
    return "always"
  }
  if (value === "d") {
    return "by_default"
  }
  throw malformed("identity must be empty, 'a', or 'd'")
}

function mapConstraintClassification(value: unknown): ConstraintClassification {
  switch (value) {
    case "p":
      return "primary_key"
    case "u":
      return "unique"
    case "f":
      return "foreign_key"
    case "c":
      return "check"
    case "x":
      return "exclusion"
    default:
      throw malformed("constraint_type must be 'p', 'u', 'f', 'c', or 'x'")
  }
}

function mapForeignKeyAction(value: unknown, field: string): ForeignKeyAction {
  switch (value) {
    case "a":
      return "no_action"
    case "r":
      return "restrict"
    case "c":
      return "cascade"
    case "n":
      return "set_null"
    case "d":
      return "set_default"
    default:
      throw malformed(`${field} must be 'a', 'r', 'c', 'n', or 'd'`)
  }
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw malformed(`${field} must be a non-empty array of strings`)
  }
  if (
    value.some((element) => typeof element !== "string" || element.length === 0)
  ) {
    throw malformed(`${field} must contain only non-empty strings`)
  }
  return Object.freeze([...(value as string[])])
}

// Index key columns: null marks an expression position (pg_index indkey 0).
function requireIndexColumnArray(
  value: unknown,
  field: string,
): readonly (string | null)[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw malformed(`${field} must be a non-empty array`)
  }
  for (const element of value) {
    if (
      element !== null &&
      (typeof element !== "string" || element.length === 0)
    ) {
      throw malformed(`${field} must contain only non-empty strings or null`)
    }
  }
  return Object.freeze([...(value as (string | null)[])])
}

function mapConstraint(row: SchemaCatalogueRow): SchemaConstraint {
  const classification = mapConstraintClassification(row.constraint_type)
  const name = requireString(row.name, "name")

  if (classification === "check") {
    // A check constraint carries no column list and no referenced target.
    requireNull(row.constraint_columns, "constraint_columns")
    requireNull(row.ref_schema, "ref_schema")
    requireNull(row.ref_table, "ref_table")
    requireNull(row.ref_columns, "ref_columns")
    requireNull(row.on_update, "on_update")
    requireNull(row.on_delete, "on_delete")
    return Object.freeze({
      name,
      classification,
      columns: Object.freeze([] as readonly string[]),
      references: null,
      onUpdate: null,
      onDelete: null,
    })
  }

  const columns = requireStringArray(
    row.constraint_columns,
    "constraint_columns",
  )

  if (classification === "foreign_key") {
    return Object.freeze({
      name,
      classification,
      columns,
      references: Object.freeze({
        schema: requireString(row.ref_schema, "ref_schema"),
        table: requireString(row.ref_table, "ref_table"),
        columns: requireStringArray(row.ref_columns, "ref_columns"),
      }),
      onUpdate: mapForeignKeyAction(row.on_update, "on_update"),
      onDelete: mapForeignKeyAction(row.on_delete, "on_delete"),
    })
  }

  // primary_key, unique, exclusion: constrained columns only, never a
  // referenced target or update/delete actions.
  requireNull(row.ref_schema, "ref_schema")
  requireNull(row.ref_table, "ref_table")
  requireNull(row.ref_columns, "ref_columns")
  requireNull(row.on_update, "on_update")
  requireNull(row.on_delete, "on_delete")
  return Object.freeze({
    name,
    classification,
    columns,
    references: null,
    onUpdate: null,
    onDelete: null,
  })
}

function mapIndex(row: SchemaCatalogueRow): SchemaIndex {
  const isUnique = requireBoolean(row.is_unique, "is_unique")
  const isExpression = requireBoolean(row.is_expression, "is_expression")
  const hasPredicate = requireBoolean(row.has_predicate, "has_predicate")
  const columns = requireIndexColumnArray(row.index_columns, "index_columns")
  if (!isExpression && columns.some((column) => column === null)) {
    throw malformed("index columns contain null without is_expression")
  }

  // An expression index stays classified as an expression index even when it
  // is also partial; the flags carry the exact state.
  const classification: IndexClassification = isExpression
    ? "expression_index"
    : hasPredicate
      ? "partial_index"
      : "index"

  return Object.freeze({
    name: requireString(row.name, "name"),
    classification,
    isUnique,
    isExpression,
    hasPredicate,
    columns,
  })
}

function mapColumn(row: SchemaCatalogueRow): SchemaCatalogueColumn {
  const generated = mapGenerated(row.generated)
  // A pg_attrdef entry of a generated column is its generation expression,
  // never a default, so defaultExpression stays null for stored and virtual
  // generated columns alike.
  const defaultExpression =
    generated === "none" && row.default_expression !== null
      ? requireString(row.default_expression, "default_expression")
      : null

  const type: TypeIdentity = Object.freeze({
    schema: requireString(row.type_schema, "type_schema"),
    name: requireString(row.type_name, "type_name"),
    kind: mapTypeKind(row.type_kind, "type_kind"),
  })

  // Invariant: baseType is the immediate pg_type.typbasetype of the declared
  // type, present if and only if the declared type is a domain. The immediate
  // base may itself be a domain; it is reported as-is without recursing.
  let baseType: TypeIdentity | null
  if (type.kind === "domain") {
    if (row.base_type_name === null) {
      throw malformed("domain type is missing its immediate base type")
    }
    baseType = Object.freeze({
      schema: requireString(row.base_type_schema, "base_type_schema"),
      name: requireString(row.base_type_name, "base_type_name"),
      kind: mapTypeKind(row.base_type_kind, "base_type_kind"),
    })
  } else {
    if (row.base_type_name !== null) {
      throw malformed("base type reported for a non-domain type")
    }
    requireNull(row.base_type_schema, "base_type_schema")
    requireNull(row.base_type_kind, "base_type_kind")
    baseType = null
  }

  return Object.freeze({
    ordinal: requireOrdinal(row.ordinal),
    name: requireString(row.name, "name"),
    isNullable: requireBoolean(row.is_nullable, "is_nullable"),
    defaultExpression,
    generated,
    identity: mapIdentity(row.identity),
    renderedType: requireString(row.rendered_type, "rendered_type"),
    type,
    baseType,
  })
}

function compareByName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

interface ValidatedTable {
  readonly owner: string
  readonly kind: SchemaTableKind
  readonly hasRowSecurity: boolean
  readonly hasForcedRowSecurity: boolean
  readonly columns: SchemaCatalogueColumn[]
  readonly constraints: SchemaConstraint[]
  readonly indexes: SchemaIndex[]
}

/**
 * Group validated catalogue rows into the deterministic public model. Every
 * row is validated before any model object is built: each row kind must
 * carry NULL in every field owned by another kind, duplicate schema names,
 * table keys, column ordinals/names, constraint names, index names, and
 * orphan tables/columns/constraints/indexes (rows whose parent does not
 * appear in the read) all fail closed with INTERNAL_ERROR instead of
 * fabricating or silently dropping metadata. Sorting happens here (schemas
 * by name, tables by name, columns by ordinal, constraints and indexes by
 * name) so results are deterministic regardless of input row order or
 * database collation.
 */
export function mapSchemaCatalogue(
  schemaRows: readonly SchemaCatalogueRow[],
  tableRows: readonly SchemaCatalogueRow[],
  columnRows: readonly SchemaCatalogueRow[],
  constraintRows: readonly SchemaCatalogueRow[] = [],
  indexRows: readonly SchemaCatalogueRow[] = [],
): SchemaCatalogue {
  const schemaOwners = new Map<string, string>()
  for (const row of schemaRows) {
    if (row.row_kind !== "schema") {
      throw malformed("schema row set contains a non-schema row")
    }
    for (const field of SCHEMA_ROW_NULL_FIELDS) {
      requireNull(row[field], field)
    }
    const name = requireString(row.schema_name, "schema_name")
    if (schemaOwners.has(name)) {
      throw malformed(`duplicate schema "${name}"`)
    }
    schemaOwners.set(name, requireString(row.owner, "owner"))
  }

  const tablesBySchema = new Map<string, Map<string, ValidatedTable>>()
  for (const row of tableRows) {
    if (row.row_kind !== "table") {
      throw malformed("table row set contains a non-table row")
    }
    for (const field of TABLE_ROW_NULL_FIELDS) {
      requireNull(row[field], field)
    }
    const schemaName = requireString(row.schema_name, "schema_name")
    const tableName = requireString(row.table_name, "table_name")
    if (!schemaOwners.has(schemaName)) {
      throw malformed(
        `table "${schemaName}.${tableName}" has no matching schema row`,
      )
    }
    let tables = tablesBySchema.get(schemaName)
    if (tables === undefined) {
      tables = new Map()
      tablesBySchema.set(schemaName, tables)
    }
    if (tables.has(tableName)) {
      throw malformed(`duplicate table "${schemaName}.${tableName}"`)
    }
    tables.set(tableName, {
      owner: requireString(row.owner, "owner"),
      kind: mapTableKind(row.kind),
      hasRowSecurity: requireBoolean(row.has_row_security, "has_row_security"),
      hasForcedRowSecurity: requireBoolean(
        row.has_forced_row_security,
        "has_forced_row_security",
      ),
      columns: [],
      constraints: [],
      indexes: [],
    })
  }

  for (const row of columnRows) {
    if (row.row_kind !== "column") {
      throw malformed("column row set contains a non-column row")
    }
    for (const field of COLUMN_ROW_NULL_FIELDS) {
      requireNull(row[field], field)
    }
    const schemaName = requireString(row.schema_name, "schema_name")
    const tableName = requireString(row.table_name, "table_name")
    const table = tablesBySchema.get(schemaName)?.get(tableName)
    if (table === undefined) {
      throw malformed(
        `column row for "${schemaName}.${tableName}" has no matching table row`,
      )
    }
    const column = mapColumn(row)
    for (const existing of table.columns) {
      if (existing.ordinal === column.ordinal) {
        throw malformed(
          `duplicate ordinal ${column.ordinal} in "${schemaName}.${tableName}"`,
        )
      }
      if (existing.name === column.name) {
        throw malformed(
          `duplicate column "${column.name}" in "${schemaName}.${tableName}"`,
        )
      }
    }
    table.columns.push(column)
  }

  for (const row of constraintRows) {
    if (row.row_kind !== "constraint") {
      throw malformed("constraint row set contains a non-constraint row")
    }
    for (const field of CONSTRAINT_ROW_NULL_FIELDS) {
      requireNull(row[field], field)
    }
    const schemaName = requireString(row.schema_name, "schema_name")
    const tableName = requireString(row.table_name, "table_name")
    const table = tablesBySchema.get(schemaName)?.get(tableName)
    if (table === undefined) {
      throw malformed(
        `constraint row for "${schemaName}.${tableName}" has no matching table row`,
      )
    }
    const constraint = mapConstraint(row)
    if (
      table.constraints.some((existing) => existing.name === constraint.name)
    ) {
      throw malformed(
        `duplicate constraint "${constraint.name}" in "${schemaName}.${tableName}"`,
      )
    }
    table.constraints.push(constraint)
  }

  for (const row of indexRows) {
    if (row.row_kind !== "index") {
      throw malformed("index row set contains a non-index row")
    }
    for (const field of INDEX_ROW_NULL_FIELDS) {
      requireNull(row[field], field)
    }
    const schemaName = requireString(row.schema_name, "schema_name")
    const tableName = requireString(row.table_name, "table_name")
    const table = tablesBySchema.get(schemaName)?.get(tableName)
    if (table === undefined) {
      throw malformed(
        `index row for "${schemaName}.${tableName}" has no matching table row`,
      )
    }
    const index = mapIndex(row)
    if (table.indexes.some((existing) => existing.name === index.name)) {
      throw malformed(
        `duplicate index "${index.name}" in "${schemaName}.${tableName}"`,
      )
    }
    table.indexes.push(index)
  }

  const schemas: SchemaCatalogueSchema[] = []
  for (const [name, owner] of schemaOwners) {
    const tables: SchemaCatalogueTable[] = []
    const tableMap = tablesBySchema.get(name)
    if (tableMap !== undefined) {
      for (const [tableName, table] of tableMap) {
        table.columns.sort((a, b) => a.ordinal - b.ordinal)
        table.constraints.sort(compareByName)
        table.indexes.sort(compareByName)
        tables.push(
          Object.freeze({
            schema: name,
            name: tableName,
            owner: table.owner,
            kind: table.kind,
            hasRowSecurity: table.hasRowSecurity,
            hasForcedRowSecurity: table.hasForcedRowSecurity,
            columns: Object.freeze(table.columns),
            constraints: Object.freeze(table.constraints),
            indexes: Object.freeze(table.indexes),
          }),
        )
      }
    }
    tables.sort(compareByName)
    schemas.push(
      Object.freeze({
        name,
        owner,
        tables: Object.freeze(tables),
      }),
    )
  }
  schemas.sort(compareByName)

  return Object.freeze({ schemas: Object.freeze(schemas) })
}

/**
 * Execute the single fixed catalogue read and map it into the frozen
 * contract model. Dependency errors pass through the existing safe
 * database error translation boundary.
 */
export async function readSchemaCatalogue(
  query: SchemaCatalogueDependencies["query"],
): Promise<SchemaCatalogue> {
  let result: pg.QueryResult<SchemaCatalogueRow>

  try {
    result = await query<SchemaCatalogueRow>(SCHEMA_CATALOGUE_SQL)
  } catch (error: unknown) {
    throw translatePoolError(error)
  }

  const schemaRows: SchemaCatalogueRow[] = []
  const tableRows: SchemaCatalogueRow[] = []
  const columnRows: SchemaCatalogueRow[] = []
  const constraintRows: SchemaCatalogueRow[] = []
  const indexRows: SchemaCatalogueRow[] = []
  for (const row of result.rows) {
    switch (row.row_kind) {
      case "schema":
        schemaRows.push(row)
        break
      case "table":
        tableRows.push(row)
        break
      case "column":
        columnRows.push(row)
        break
      case "constraint":
        constraintRows.push(row)
        break
      case "index":
        indexRows.push(row)
        break
      default:
        throw malformed(
          "row_kind must be 'schema', 'table', 'column', 'constraint', or 'index'",
        )
    }
  }

  return mapSchemaCatalogue(
    schemaRows,
    tableRows,
    columnRows,
    constraintRows,
    indexRows,
  )
}

/** Create a read-only schema-catalogue reader over an injected query. */
export function createSchemaCatalogueReader(
  deps: SchemaCatalogueDependencies,
): SchemaCatalogueReader {
  return Object.freeze({
    read: () => readSchemaCatalogue(deps.query),
  })
}
