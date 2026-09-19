// Test-only SQL identifier/literal quoting helpers.
//
// These are intentionally minimal and audited: they protect the integration
// suite from SQL injection without adding a runtime dependency. They are not
// exported from the application runtime.

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

export function quoteIdentifier(name: string): string {
  if (!SIMPLE_IDENTIFIER.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`)
  }
  return `"${name.replace(/"/g, '""')}"`
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
