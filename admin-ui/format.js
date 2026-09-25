// Pure presentation helpers for the management UI. No DOM access, no network
// access — every function is deterministic so the unit suite can import them
// directly from Node.

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/**
 * Escape one untrusted value for interpolation into an HTML string. Every
 * render path in render.js routes catalogue data through this helper —
 * schema, table, and column names come straight from the database.
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

const LABELS = {
  regular: "Regular",
  partitioned: "Partitioned",
  internal: "Internal",
  operator: "Operator",
  primary_key: "Primary key",
  unique: "Unique",
  foreign_key: "Foreign key",
  check: "Check",
  exclusion: "Exclusion",
  index: "Index",
  expression_index: "Expression index",
  partial_index: "Partial index",
  none: "None",
  stored: "Stored",
  virtual: "Virtual",
  always: "Always",
  by_default: "By default",
  no_action: "NO ACTION",
  restrict: "RESTRICT",
  cascade: "CASCADE",
  set_null: "SET NULL",
  set_default: "SET DEFAULT",
  succeeded: "Succeeded",
  failed: "Failed",
  pending: "Pending",
}

/** Human-readable label for a frozen enum value; unknown values pass through. */
export function humanize(value) {
  return Object.hasOwn(LABELS, value) ? LABELS[value] : String(value)
}

/**
 * Format an ISO-8601 timestamp as deterministic UTC text so rendered views
 * and their tests never depend on the viewer's timezone.
 */
export function formatUtcDateTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return String(iso)
  }
  const pad = (n) => String(n).padStart(2, "0")
  const y = date.getUTCFullYear()
  const m = pad(date.getUTCMonth() + 1)
  const d = pad(date.getUTCDate())
  const hh = pad(date.getUTCHours())
  const mm = pad(date.getUTCMinutes())
  const ss = pad(date.getUTCSeconds())
  return `${y}-${m}-${d} ${hh}:${mm}:${ss} UTC`
}

/**
 * Render a catalogue column list. null marks an expression position in an
 * index key; those render as "expression" so an expression index is never
 * misrepresented as a plain column list.
 */
export function formatColumnList(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    return "—"
  }
  return columns.map((name) => (name === null ? "expression" : name)).join(", ")
}
