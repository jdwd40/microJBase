// Startup configuration for microJBase v0.1.
//
// Reads the environment contract defined in ARCHITECTURE.md section 6.
// Invalid values fail at startup with operator-facing messages.
// Secrets are redacted before logging or error text.

import { URL } from "node:url"

import { AppError } from "./errors.js"

const VALID_LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const
export type LogLevel = (typeof VALID_LOG_LEVELS)[number]

export interface AppConfig {
  databaseUrl: string
  migrationDatabaseUrl: string | null
  schemaDatabaseUrl: string | null
  adminTokenSha256: string | null
  host: string
  port: number
  logLevel: LogLevel
  sessionTtlSeconds: number
  tables: readonly ExposedTableMapping[]
  trustProxy: boolean
  maxBodyBytes: number
}

export interface ExposedTableMapping {
  alias: string
  schema: string
  table: string
}

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 3000,
  logLevel: "info" as LogLevel,
  sessionTtlSeconds: 604800,
  trustProxy: false,
  maxBodyBytes: 1048576,
} as const

const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

export function parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = requireNonEmptyString(env, "DATABASE_URL")
  const migrationDatabaseUrl = optionalNonEmptyString(
    env,
    "MIGRATION_DATABASE_URL",
  )
  const schemaDatabaseUrl = optionalNonEmptyString(env, "SCHEMA_DATABASE_URL")
  const adminTokenSha256 = parseAdminTokenDigest(
    optionalNonEmptyString(env, "MICROJBASE_ADMIN_TOKEN_SHA256"),
  )
  assertSchemaAdminConfigPairing(schemaDatabaseUrl, adminTokenSha256)
  assertSchemaAdminUrlDistinct(databaseUrl, schemaDatabaseUrl)
  const host = env.HOST ?? DEFAULTS.host
  const port = parsePort(env.PORT)
  const logLevel = parseLogLevel(env.LOG_LEVEL)
  const sessionTtlSeconds = parsePositiveInt(
    env.SESSION_TTL_SECONDS,
    DEFAULTS.sessionTtlSeconds,
    "SESSION_TTL_SECONDS",
  )
  const trustProxy = parseBoolean(env.TRUST_PROXY, DEFAULTS.trustProxy)
  const maxBodyBytes = parsePositiveInt(
    env.MAX_BODY_BYTES,
    DEFAULTS.maxBodyBytes,
    "MAX_BODY_BYTES",
  )
  const tables = parseTableMappings(env.MICROJBASE_TABLES)

  return {
    databaseUrl,
    migrationDatabaseUrl,
    schemaDatabaseUrl,
    adminTokenSha256,
    host,
    port,
    logLevel,
    sessionTtlSeconds,
    tables,
    trustProxy,
    maxBodyBytes,
  }
}

function requireNonEmptyString(
  env: NodeJS.ProcessEnv,
  key: string,
  options: { redact?: boolean } = {},
): string {
  const raw = env[key]
  if (raw === undefined || raw.trim().length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${key} is required`,
      400,
      options.redact ? undefined : { variable: key },
    )
  }
  return raw
}

function optionalNonEmptyString(
  env: NodeJS.ProcessEnv,
  key: string,
): string | null {
  const raw = env[key]
  if (raw === undefined || raw.trim().length === 0) {
    return null
  }
  return raw
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

// The configured operator-token digest is a SHA-256 hex rendering. Rejecting
// malformed digests at startup catches operator paste errors before the
// admin module is silently half-configured.
function parseAdminTokenDigest(raw: string | null): string | null {
  if (raw === null) {
    return null
  }
  const normalized = raw.trim().toLowerCase()
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "MICROJBASE_ADMIN_TOKEN_SHA256 must be a 64-character lowercase SHA-256 hex digest",
      400,
      { variable: "MICROJBASE_ADMIN_TOKEN_SHA256" },
    )
  }
  return normalized
}

// The schema-admin module is opt-in and disabled by default: both the
// schema-admin connection URL and the operator-token digest must be
// configured together, or the module is inert. Exactly one of the two is an
// operator mistake and must fail startup (D-012).
function assertSchemaAdminConfigPairing(
  schemaDatabaseUrl: string | null,
  adminTokenSha256: string | null,
): void {
  if ((schemaDatabaseUrl === null) !== (adminTokenSha256 === null)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "SCHEMA_DATABASE_URL and MICROJBASE_ADMIN_TOKEN_SHA256 must be configured together",
      400,
      {
        variables: ["SCHEMA_DATABASE_URL", "MICROJBASE_ADMIN_TOKEN_SHA256"],
      },
    )
  }
}

// The schema-admin lane must never share the runtime data connection surface
// (D-011). It may share a role with the migration lane, but never with the
// restricted runtime lane. Comparing raw URL strings misses equivalent
// spellings of the same surface (postgres:// vs postgresql://, localhost vs
// 127.0.0.1, default ports, query parameters), so the comparison normalizes
// the scheme-independent parts and ignores credentials, query, and fragment.
// The live-session check at startup (assertSchemaAdminSessionDistinct) is the
// second layer for aliases a URL cannot reveal.
function normalizePostgresUrl(raw: string): {
  username: string
  host: string
  port: number
  database: string
} | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return null
  }
  let host = parsed.hostname.toLowerCase()
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    host = "127.0.0.1"
  }
  const port = parsed.port === "" ? 5432 : Number(parsed.port)
  const database = parsed.pathname.replace(/^\//, "")
  return {
    username: decodeURIComponent(parsed.username),
    host,
    port,
    database,
  }
}

function assertSchemaAdminUrlDistinct(
  databaseUrl: string,
  schemaDatabaseUrl: string | null,
): void {
  if (schemaDatabaseUrl === null) {
    return
  }
  const normalizedRuntime = normalizePostgresUrl(databaseUrl)
  const normalizedAdmin = normalizePostgresUrl(schemaDatabaseUrl)
  const sameSurface =
    schemaDatabaseUrl === databaseUrl ||
    (normalizedRuntime !== null &&
      normalizedAdmin !== null &&
      normalizedRuntime.username === normalizedAdmin.username &&
      normalizedRuntime.host === normalizedAdmin.host &&
      normalizedRuntime.port === normalizedAdmin.port &&
      normalizedRuntime.database === normalizedAdmin.database)
  if (sameSurface) {
    throw new AppError(
      "VALIDATION_ERROR",
      "SCHEMA_DATABASE_URL must not equal DATABASE_URL (the runtime data role)",
      400,
      { variable: "SCHEMA_DATABASE_URL" },
    )
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULTS.port
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new AppError(
      "VALIDATION_ERROR",
      `PORT must be an integer between 1 and 65535`,
      400,
      {
        variable: "PORT",
      },
    )
  }
  return value
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULTS.logLevel
  }
  const level = raw.trim().toLowerCase() as LogLevel
  if (!VALID_LOG_LEVELS.includes(level)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(", ")}`,
      400,
      { variable: "LOG_LEVEL" },
    )
  }
  return level
}

function parsePositiveInt(
  raw: string | undefined,
  defaultValue: number,
  variable: string,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return defaultValue
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${variable} must be a positive integer`,
      400,
      {
        variable,
      },
    )
  }
  return value
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return defaultValue
  }
  const normalized = raw.trim().toLowerCase()
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false
  }
  throw new AppError(
    "VALIDATION_ERROR",
    "TRUST_PROXY must be a boolean (true/false/1/0/yes/no/on/off)",
    400,
    { variable: "TRUST_PROXY" },
  )
}

function parseTableMappings(
  raw: string | undefined,
): readonly ExposedTableMapping[] {
  if (raw === undefined || raw.trim().length === 0) {
    return []
  }

  const entries = raw.split(",").map((entry) => entry.trim())
  const seenAliases = new Set<string>()
  const mappings: ExposedTableMapping[] = []

  for (const entry of entries) {
    if (entry.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "MICROJBASE_TABLES contains an empty entry",
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }

    const separatorIndex = entry.indexOf("=")
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new AppError(
        "VALIDATION_ERROR",
        `MICROJBASE_TABLES entry "${entry}" must be in the form alias=schema.table`,
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }

    const alias = entry.slice(0, separatorIndex).trim()
    const target = entry.slice(separatorIndex + 1).trim()
    const parsed = parseTableTarget(target)

    if (!ALIAS_PATTERN.test(alias)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `MICROJBASE_TABLES alias "${alias}" must match ${ALIAS_PATTERN.source}`,
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }

    if (seenAliases.has(alias)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `MICROJBASE_TABLES alias "${alias}" is defined more than once`,
        400,
        { variable: "MICROJBASE_TABLES" },
      )
    }
    seenAliases.add(alias)

    mappings.push({ alias, schema: parsed.schema, table: parsed.table })
  }

  return mappings
}

const FORBIDDEN_SCHEMAS = new Set([
  "microjbase",
  "pg_catalog",
  "information_schema",
])

function parseTableTarget(target: string): { schema: string; table: string } {
  const parts = target.split(".")
  if (parts.length !== 2 || parts[0]?.length === 0 || parts[1]?.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MICROJBASE_TABLES target "${target}" must be schema.table`,
      400,
      { variable: "MICROJBASE_TABLES" },
    )
  }
  const schema = parts[0] as string
  const table = parts[1] as string

  if (FORBIDDEN_SCHEMAS.has(schema.toLowerCase())) {
    throw new AppError(
      "VALIDATION_ERROR",
      `MICROJBASE_TABLES schema "${schema}" cannot be exposed`,
      400,
      { variable: "MICROJBASE_TABLES" },
    )
  }

  return { schema, table }
}

const SENSITIVE_KEY_PATTERNS = [
  /^password$/,
  /^password_?hash$/,
  /^hash$/,
  /^token$/,
  /^token_?hash$/,
  /^bearer_?token$/,
  /^access_?token$/,
  /^session_?token$/,
  /^refresh_?token$/,
  /^secret$/,
  /^api_?key$/,
  /^auth(orization)?$/,
  /^cookie$/,
  /^database_?url$/,
  /^connection_?string$/,
]

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/_/g, "")
  return SENSITIVE_KEY_PATTERNS.some((pattern) =>
    pattern.test(normalized.replace(/_/g, "")),
  )
}

export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      const redacted = redactSecrets(parsed)
      return JSON.stringify(redacted)
    } catch {
      return redactStringValue(value)
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item))
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(record)) {
      if (isSensitiveKey(key)) {
        result[key] = "***"
      } else {
        result[key] = redactSecrets(val)
      }
    }
    return result
  }

  return value
}

function redactStringValue(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.password) {
      parsed.password = "***"
      return parsed.toString()
    }
  } catch {
    // Not a URL; leave value unchanged.
  }
  return value
}

export function redactUrlPassword(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) {
      parsed.password = "***"
    }
    return parsed.toString()
  } catch {
    return "***"
  }
}

export function safeConfigForLogging(
  config: AppConfig,
): Record<string, unknown> {
  return {
    ...config,
    databaseUrl: redactUrlPassword(config.databaseUrl),
    migrationDatabaseUrl: config.migrationDatabaseUrl
      ? redactUrlPassword(config.migrationDatabaseUrl)
      : null,
    schemaDatabaseUrl: config.schemaDatabaseUrl
      ? redactUrlPassword(config.schemaDatabaseUrl)
      : null,
    // The operator-token digest is never logged, even though the operator
    // supplied it: config logs routinely ship to aggregators, and the digest
    // is the only stored secret-equivalent of the admin lane.
    adminTokenSha256: config.adminTokenSha256 ? "***" : null,
  }
}
