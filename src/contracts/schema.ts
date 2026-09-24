// Frozen schema-catalogue and schema-snapshot contracts for microJBase v0.2
// (V02-01..V02-03).
// Architect-owned: proposed changes require the CONTRACTS.md change process.
//
// These types are dependency-free: no database driver, web framework,
// filesystem, environment, or runtime-library imports. They describe
// read-only PostgreSQL catalogue metadata as observed by the schema reader;
// this module never decides data-API writability.

/** Canonical catalogue identity of a PostgreSQL type (pg_type/pg_namespace). */
export interface TypeIdentity {
  /** Namespace that owns the type, e.g. "pg_catalog" or a user schema. */
  readonly schema: string
  /** PostgreSQL type name, e.g. "int4", "text", or a domain name. */
  readonly name: string
  /** pg_type.typtype classification mapped to a stable literal. */
  readonly kind:
    "base" | "domain" | "enum" | "range" | "multirange" | "composite" | "pseudo"
}

export type SchemaTableKind = "regular" | "partitioned"

/**
 * pg_attribute.attgenerated mapped to a stable literal:
 * '' (none), 's' (stored), or 'v' (virtual; PostgreSQL 18+).
 */
export type ColumnGeneratedKind = "none" | "stored" | "virtual"

/** pg_attribute.attidentity: '' (none), 'a' (always), 'd' (by default). */
export type ColumnIdentityKind = "none" | "always" | "by_default"

export interface SchemaCatalogueColumn {
  /** Stable PostgreSQL attribute number (pg_attribute.attnum). */
  readonly ordinal: number
  readonly name: string
  readonly isNullable: boolean
  /**
   * Rendered default expression (pg_get_expr) as opaque text, or null.
   * The text is never parsed or executed by this reader. Null for columns
   * without a default and for generated columns, whose pg_attrdef entry is
   * a generation expression rather than a default.
   */
  readonly defaultExpression: string | null
  /** Generated-column state reported by PostgreSQL. */
  readonly generated: ColumnGeneratedKind
  /** Identity-column state reported by PostgreSQL. */
  readonly identity: ColumnIdentityKind
  /** format_type(atttypid, atttypmod) rendering of the declared type. */
  readonly renderedType: string
  /** Declared type identity; a declared domain stays a domain here. */
  readonly type: TypeIdentity
  /**
   * Immediate base type of the declared type: pg_type.typbasetype of the
   * declared type when (and only when) the declared type is a domain. The
   * immediate base may itself be a domain; this reader does not recurse.
   * Null when the declared type is not a domain.
   */
  readonly baseType: TypeIdentity | null
}

export interface SchemaCatalogueTable {
  readonly schema: string
  readonly name: string
  readonly owner: string
  /** Regular versus partitioned table (pg_class.relkind 'r' vs 'p'). */
  readonly kind: SchemaTableKind
  /** pg_class.relrowsecurity. */
  readonly hasRowSecurity: boolean
  /** pg_class.relforcerowsecurity. */
  readonly hasForcedRowSecurity: boolean
  /** Columns in stable ordinal order. */
  readonly columns: readonly SchemaCatalogueColumn[]
  /** Constraints in deterministic name order. */
  readonly constraints: readonly SchemaConstraint[]
  /**
   * Standalone indexes in deterministic name order. The backing index of a
   * table constraint (primary key, unique, exclusion) is represented by that
   * constraint and never appears here; see SchemaConstraint.
   */
  readonly indexes: readonly SchemaIndex[]
}

export interface SchemaCatalogueSchema {
  readonly name: string
  readonly owner: string
  /** Tables in this schema, sorted by name; empty for empty schemas. */
  readonly tables: readonly SchemaCatalogueTable[]
}

/**
 * pg_constraint.contype mapped to a stable literal. "check" and "exclusion"
 * are reported as classified read-only metadata: they are never manageable
 * through microJBase, but they are never silently dropped either.
 */
export type ConstraintClassification =
  "primary_key" | "unique" | "foreign_key" | "check" | "exclusion"

/**
 * pg_constraint.confupdatetype/confdeltype mapped to stable literals.
 * "set_default" is reported as observed data; the v0.2 management allowlist
 * excludes it (see docs/v0.2-implementation-plan.md).
 */
export type ForeignKeyAction =
  "no_action" | "restrict" | "cascade" | "set_null" | "set_default"

/** Referenced target of a foreign-key constraint. */
export interface SchemaForeignKeyTarget {
  readonly schema: string
  readonly table: string
  readonly columns: readonly string[]
}

export interface SchemaConstraint {
  readonly name: string
  readonly classification: ConstraintClassification
  /**
   * Ordered constrained column names (pg_constraint.conkey order). Empty for
   * "check" constraints, which carry no column list.
   */
  readonly columns: readonly string[]
  /** Foreign keys only; null for every other classification. */
  readonly references: SchemaForeignKeyTarget | null
  /** Foreign keys only; null for every other classification. */
  readonly onUpdate: ForeignKeyAction | null
  /** Foreign keys only; null for every other classification. */
  readonly onDelete: ForeignKeyAction | null
}

/**
 * Construct classification for a standalone index. "expression_index" takes
 * precedence over "partial_index" when both apply; the flags below always
 * carry the exact state. Expression and partial indexes are read-only in
 * v0.2 (see docs/v0.2-scope.md non-goals) but are reported, not dropped.
 */
export type IndexClassification = "index" | "expression_index" | "partial_index"

export interface SchemaIndex {
  readonly name: string
  readonly classification: IndexClassification
  /** True when the index is declared UNIQUE. */
  readonly isUnique: boolean
  /** True when the index key contains expressions (pg_index.indexprs). */
  readonly isExpression: boolean
  /** True when the index is partial (pg_index.indpred). */
  readonly hasPredicate: boolean
  /**
   * Ordered key column names; null marks an expression position, so an
   * expression index is never misrepresented as a plain column list.
   */
  readonly columns: readonly (string | null)[]
}

/** Immutable, deterministically ordered read-only schema catalogue. */
export interface SchemaCatalogue {
  /**
   * All non-system schemas (system schemas and names beginning "pg_"
   * excluded), sorted by name. Empty schemas are included.
   */
  readonly schemas: readonly SchemaCatalogueSchema[]
}

/** Read-only schema-catalogue port implemented by the database adapter. */
export interface SchemaCatalogueReader {
  read(): Promise<SchemaCatalogue>
}

/**
 * Snapshot classification. "internal" objects (microjbase, pg_catalog,
 * information_schema, and any pg_* name) are permanently ineligible for
 * exposure or mutation and are never presented as manageable; "operator"
 * objects are everything else and remain subject to the capability checks
 * introduced in V02-04 and later.
 */
export type SchemaObjectClassification = "internal" | "operator"

/** Data-API exposure state of one table, from the v0.1 table registry. */
export interface SchemaSnapshotExposure {
  readonly exposed: boolean
  /** Data-API alias when exposed; null otherwise. */
  readonly alias: string | null
}

export interface SchemaSnapshotTable extends SchemaCatalogueTable {
  readonly classification: SchemaObjectClassification
  readonly exposure: SchemaSnapshotExposure
}

export interface SchemaSnapshotSchema extends SchemaCatalogueSchema {
  readonly classification: SchemaObjectClassification
  readonly tables: readonly SchemaSnapshotTable[]
}

/** One applied migration as recorded in microjbase.schema_migrations. */
export interface SchemaMigrationRecord {
  readonly filename: string
  readonly checksum: string
  /** Deterministic UTC ISO-8601 rendering of applied_at. */
  readonly appliedAt: string
}

/**
 * Immutable, deterministically ordered point-in-time schema state: the full
 * catalogue plus per-object classification and exposure state, plus the
 * forward-only migration history.
 */
export interface SchemaSnapshot {
  readonly schemas: readonly SchemaSnapshotSchema[]
  readonly migrations: readonly SchemaMigrationRecord[]
}

/** Read-only schema-snapshot port implemented by the database adapter. */
export interface SchemaSnapshotReader {
  readSnapshot(): Promise<SchemaSnapshot>
}
