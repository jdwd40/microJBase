// Audited SQL identifier quoting helper for microJBase v0.1.
//
// Dynamic identifiers may only originate from verified registry metadata.
// This helper rejects any name that does not match the conservative simple
// identifier pattern, then quotes it safely for PostgreSQL.

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

export function quoteIdentifier(name: string): string {
  if (!SIMPLE_IDENTIFIER.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`)
  }
  return `"${name.replace(/"/g, '""')}"`
}

export function quoteQualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
}
