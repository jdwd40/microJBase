// Frozen schema-catalogue contracts for microJBase v0.2 (V02-01).
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

/** pg_attribute.attgenerated: '' (none) or 's' (stored). */
export type ColumnGeneratedKind = "none" | "stored"

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
   * Underlying base type identity when the declared type is a domain;
   * null when the declared type is not a domain.
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
}

export interface SchemaCatalogueSchema {
  readonly name: string
  readonly owner: string
  /** Tables in this schema, sorted by name; empty for empty schemas. */
  readonly tables: readonly SchemaCatalogueTable[]
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
