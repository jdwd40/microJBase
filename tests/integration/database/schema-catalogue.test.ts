import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"

import {
  createSchemaCatalogueReader,
  type SchemaCatalogueDependencies,
} from "../../../src/database/index.js"
import type {
  SchemaCatalogue,
  SchemaCatalogueColumn,
  SchemaCatalogueSchema,
  SchemaCatalogueTable,
} from "../../../src/contracts/index.js"
import { quoteLiteral } from "./helpers.js"
import {
  applyMigrationsAndGrants,
  cleanMigrations,
  withClient,
} from "./bootstrap.js"

const databaseUrl = process.env.INTEGRATION_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "INTEGRATION_DATABASE_URL environment variable is required for integration tests",
  )
}

const adminDatabaseUrl = process.env.INTEGRATION_ADMIN_DATABASE_URL
if (!adminDatabaseUrl) {
  throw new Error(
    "INTEGRATION_ADMIN_DATABASE_URL environment variable is required for integration tests",
  )
}

const runtimeRoleName: string = new URL(databaseUrl).username

const EMPTY_SCHEMA = "v0201_empty"
const APP_SCHEMA = "v0201_app"
const WEIRD_SCHEMA = "V0201 Weird Schema"
const FIXTURE_SCHEMAS = [EMPTY_SCHEMA, APP_SCHEMA, WEIRD_SCHEMA] as const

// Set in beforeAll: PostgreSQL 18 adds virtual generated columns
// (attgenerated 'v'); the fixture and assertions are conditional on it so
// PostgreSQL 16 CI remains valid.
let supportsVirtualGenerated = false

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>) {
  return withClient(adminDatabaseUrl as string, fn)
}

// Test-only identifier quoting for fixture DDL. Fixture names above are
// fixed, but quoting stays defensive so the setup cannot be diverted.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

async function createFixtures(): Promise<void> {
  await withAdminClient(async (admin) => {
    const version = await admin.query(
      "SELECT current_setting('server_version_num') AS server_version_num",
    )
    supportsVirtualGenerated =
      Number.parseInt(version.rows[0]?.server_version_num as string, 10) >=
      180000

    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdent(WEIRD_SCHEMA)} CASCADE`,
    )
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(APP_SCHEMA)} CASCADE`)
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdent(EMPTY_SCHEMA)} CASCADE`,
    )

    await admin.query(`CREATE SCHEMA ${quoteIdent(EMPTY_SCHEMA)}`)
    await admin.query(`CREATE SCHEMA ${quoteIdent(APP_SCHEMA)}`)
    await admin.query(
      `CREATE DOMAIN ${quoteIdent(APP_SCHEMA)}.postal_code AS text CHECK (VALUE ~ '^[0-9]{5}$')`,
    )
    const virtualColumn = supportsVirtualGenerated
      ? ",\n        title_len_virtual integer GENERATED ALWAYS AS (length(title)) VIRTUAL"
      : ""
    await admin.query(`
      CREATE TABLE ${quoteIdent(APP_SCHEMA)}.articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        body text,
        priority integer NOT NULL DEFAULT 42,
        created_at timestamptz NOT NULL DEFAULT now(),
        seq integer GENERATED ALWAYS AS IDENTITY,
        slug_length integer GENERATED ALWAYS AS (length(title)) STORED,
        postal ${quoteIdent(APP_SCHEMA)}.postal_code DEFAULT '12345'::${quoteIdent(APP_SCHEMA)}.postal_code${virtualColumn}
      )
    `)
    await admin.query(`
      CREATE TABLE ${quoteIdent(APP_SCHEMA)}.metrics (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid,
        value integer
      )
    `)
    await admin.query(
      `ALTER TABLE ${quoteIdent(APP_SCHEMA)}.metrics ENABLE ROW LEVEL SECURITY`,
    )
    await admin.query(
      `ALTER TABLE ${quoteIdent(APP_SCHEMA)}.metrics FORCE ROW LEVEL SECURITY`,
    )
    await admin.query(`
      CREATE TABLE ${quoteIdent(APP_SCHEMA)}.events (
        id uuid NOT NULL,
        occurred_at timestamptz NOT NULL,
        payload jsonb
      ) PARTITION BY RANGE (occurred_at)
    `)
    await admin.query(`
      CREATE TABLE ${quoteIdent(APP_SCHEMA)}.events_2026
      PARTITION OF ${quoteIdent(APP_SCHEMA)}.events
      FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')
    `)
    // Zero-column tables are valid PostgreSQL objects and must be reported.
    await admin.query(`CREATE TABLE ${quoteIdent(APP_SCHEMA)}.no_columns ()`)

    // Non-table objects must never appear in the catalogue.
    await admin.query(
      `CREATE VIEW ${quoteIdent(APP_SCHEMA)}.articles_view AS SELECT id, title FROM ${quoteIdent(APP_SCHEMA)}.articles`,
    )
    await admin.query(`
      CREATE MATERIALIZED VIEW ${quoteIdent(APP_SCHEMA)}.articles_mv AS
      SELECT id, title FROM ${quoteIdent(APP_SCHEMA)}.articles
    `)
    await admin.query(`CREATE SEQUENCE ${quoteIdent(APP_SCHEMA)}.articles_seq`)

    await admin.query(`CREATE SCHEMA ${quoteIdent(WEIRD_SCHEMA)}`)
    await admin.query(`
      CREATE TABLE ${quoteIdent(WEIRD_SCHEMA)}.${quoteIdent('weird "table" name')} (
        ${quoteIdent("sp ace")} text,
        ${quoteIdent('quo"te')} integer DEFAULT 7,
        ${quoteIdent("-- DROP TABLE users;")} text DEFAULT ''';--'
      )
    `)
  })
}

async function dropFixtures(): Promise<void> {
  await withAdminClient(async (admin) => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdent(WEIRD_SCHEMA)} CASCADE`,
    )
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(APP_SCHEMA)} CASCADE`)
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdent(EMPTY_SCHEMA)} CASCADE`,
    )
  })
}

interface CatalogueState {
  objects: unknown[]
  domains: unknown[]
  catalogueCounts: unknown[]
  migrations: unknown[]
  fixtureData: unknown[]
}

async function captureState(admin: pg.Client): Promise<CatalogueState> {
  const fixtureSchemaLiterals = FIXTURE_SCHEMAS.map((s) =>
    quoteLiteral(s),
  ).join(",")
  const objects = await admin.query(`
    SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity,
           c.relforcerowsecurity
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN (${fixtureSchemaLiterals})
    ORDER BY n.nspname, c.relname
  `)
  const domains = await admin.query(`
    SELECT t.typname
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = ${quoteLiteral(APP_SCHEMA)} AND t.typtype = 'd'
    ORDER BY t.typname
  `)
  // Database-wide catalogue counts: any catalogue mutation anywhere in the
  // database is caught, not just fixture-schema objects.
  const catalogueCounts = await admin.query(`
    SELECT (SELECT count(*) FROM pg_catalog.pg_namespace) AS namespaces,
           (SELECT count(*) FROM pg_catalog.pg_class) AS classes,
           (SELECT count(*) FROM pg_catalog.pg_attrdef) AS attrdefs
  `)
  const migrations = await admin.query(`
    SELECT filename, checksum, applied_at
    FROM microjbase.schema_migrations
    ORDER BY filename
  `)
  const articles = await admin.query(
    `SELECT * FROM ${quoteIdent(APP_SCHEMA)}.articles ORDER BY id`,
  )
  const metrics = await admin.query(
    `SELECT * FROM ${quoteIdent(APP_SCHEMA)}.metrics ORDER BY id`,
  )
  const events = await admin.query(
    `SELECT * FROM ${quoteIdent(APP_SCHEMA)}.events ORDER BY id`,
  )
  const weird = await admin.query(
    `SELECT * FROM ${quoteIdent(WEIRD_SCHEMA)}.${quoteIdent('weird "table" name')}`,
  )
  return {
    objects: objects.rows,
    domains: domains.rows,
    catalogueCounts: catalogueCounts.rows,
    migrations: migrations.rows,
    fixtureData: [articles.rows, metrics.rows, events.rows, weird.rows],
  }
}

function findSchema(
  catalogue: SchemaCatalogue,
  name: string,
): SchemaCatalogueSchema {
  const schema = catalogue.schemas.find((entry) => entry.name === name)
  expect(schema, `schema ${name} should exist`).toBeDefined()
  return schema as SchemaCatalogueSchema
}

function findTable(
  schema: SchemaCatalogueSchema,
  name: string,
): SchemaCatalogueTable {
  const table = schema.tables.find((entry) => entry.name === name)
  expect(table, `table ${name} should exist`).toBeDefined()
  return table as SchemaCatalogueTable
}

function findColumn(table: SchemaCatalogueTable, name: string) {
  const column = table.columns.find((entry) => entry.name === name)
  expect(column, `column ${name} should exist`).toBeDefined()
  return column as SchemaCatalogueColumn
}

describe("schema catalogue reader (real PostgreSQL)", () => {
  beforeAll(async () => {
    await cleanMigrations(adminDatabaseUrl)
    await applyMigrationsAndGrants(adminDatabaseUrl, runtimeRoleName)
    await createFixtures()
  })

  afterAll(async () => {
    await dropFixtures()
    await cleanMigrations(adminDatabaseUrl)
  })

  it("reports non-system schemas including empty, public, and microjbase", async () => {
    const catalogue = await readCatalogue()
    const names = catalogue.schemas.map((schema) => schema.name)

    for (const name of [
      "public",
      "microjbase",
      EMPTY_SCHEMA,
      APP_SCHEMA,
      WEIRD_SCHEMA,
    ]) {
      expect(names).toContain(name)
    }

    for (const schema of catalogue.schemas) {
      expect(schema.name).not.toBe("information_schema")
      expect(schema.name.startsWith("pg_")).toBe(false)
      expect(typeof schema.owner).toBe("string")
      expect(schema.owner.length).toBeGreaterThan(0)
    }

    expect(findSchema(catalogue, "microjbase").owner).toBe("microjbase")
    expect(findSchema(catalogue, APP_SCHEMA).owner).toBe("microjbase")
  })

  it("represents an empty schema with no tables", async () => {
    const catalogue = await readCatalogue()
    expect(findSchema(catalogue, EMPTY_SCHEMA).tables).toEqual([])
  })

  it("represents a zero-column table with an empty column list", async () => {
    const catalogue = await readCatalogue()
    const table = findTable(findSchema(catalogue, APP_SCHEMA), "no_columns")

    expect(table.kind).toBe("regular")
    expect(table.columns).toEqual([])
  })

  it("represents ordinary tables with accurate column metadata", async () => {
    const catalogue = await readCatalogue()
    const table = findTable(findSchema(catalogue, APP_SCHEMA), "articles")

    expect(table.kind).toBe("regular")
    expect(table.owner).toBe("microjbase")
    expect(table.hasRowSecurity).toBe(false)
    expect(table.hasForcedRowSecurity).toBe(false)

    const expectedNames = [
      "id",
      "title",
      "body",
      "priority",
      "created_at",
      "seq",
      "slug_length",
      "postal",
    ]
    if (supportsVirtualGenerated) {
      expectedNames.push("title_len_virtual")
    }
    expect(table.columns.map((c) => c.name)).toEqual(expectedNames)
    expect(table.columns.map((c) => c.ordinal)).toEqual(
      expectedNames.map((_, index) => index + 1),
    )

    const byName = new Map(table.columns.map((c) => [c.name, c]))

    const id = byName.get("id") as SchemaCatalogueColumn
    expect(id).toMatchObject({
      isNullable: false,
      defaultExpression: "gen_random_uuid()",
      generated: "none",
      identity: "none",
      renderedType: "uuid",
      type: { schema: "pg_catalog", name: "uuid", kind: "base" },
      baseType: null,
    })

    const title = byName.get("title") as SchemaCatalogueColumn
    expect(title.isNullable).toBe(false)
    expect(title.defaultExpression).toBeNull()

    const body = byName.get("body") as SchemaCatalogueColumn
    expect(body.isNullable).toBe(true)
    expect(body.defaultExpression).toBeNull()

    const priority = byName.get("priority") as SchemaCatalogueColumn
    expect(priority).toMatchObject({
      isNullable: false,
      defaultExpression: "42",
      renderedType: "integer",
      type: { schema: "pg_catalog", name: "int4", kind: "base" },
    })

    const createdAt = byName.get("created_at") as SchemaCatalogueColumn
    expect(createdAt.defaultExpression).toBe("now()")
    expect(createdAt.renderedType).toBe("timestamp with time zone")

    const seq = byName.get("seq") as SchemaCatalogueColumn
    expect(seq).toMatchObject({
      isNullable: false,
      defaultExpression: null,
      identity: "always",
      generated: "none",
    })

    const slugLength = byName.get("slug_length") as SchemaCatalogueColumn
    expect(slugLength).toMatchObject({
      generated: "stored",
      identity: "none",
      // The pg_attrdef entry of a generated column is its generation
      // expression, not a default; the reader reports null.
      defaultExpression: null,
    })
  })

  it("reports virtual generated columns on PostgreSQL 18+", async () => {
    const catalogue = await readCatalogue()
    const table = findTable(findSchema(catalogue, APP_SCHEMA), "articles")

    if (!supportsVirtualGenerated) {
      // PostgreSQL 16 CI: virtual generated columns do not exist there.
      expect(table.columns.map((c) => c.name)).not.toContain(
        "title_len_virtual",
      )
      return
    }

    const virtual = findColumn(table, "title_len_virtual")
    expect(virtual).toMatchObject({
      isNullable: true,
      generated: "virtual",
      identity: "none",
      renderedType: "integer",
      type: { schema: "pg_catalog", name: "int4", kind: "base" },
      baseType: null,
      // A generation expression is never a default.
      defaultExpression: null,
    })
  })

  it("reports RLS and FORCE RLS state accurately", async () => {
    const catalogue = await readCatalogue()
    const app = findSchema(catalogue, APP_SCHEMA)

    expect(findTable(app, "articles").hasRowSecurity).toBe(false)
    expect(findTable(app, "articles").hasForcedRowSecurity).toBe(false)

    const metrics = findTable(app, "metrics")
    expect(metrics.hasRowSecurity).toBe(true)
    expect(metrics.hasForcedRowSecurity).toBe(true)
  })

  it("represents partitioned tables accurately", async () => {
    const catalogue = await readCatalogue()
    const events = findTable(findSchema(catalogue, APP_SCHEMA), "events")

    expect(events.kind).toBe("partitioned")
    expect(events.columns.map((c) => c.name)).toEqual([
      "id",
      "occurred_at",
      "payload",
    ])
    expect(events.columns.map((c) => c.ordinal)).toEqual([1, 2, 3])
    expect(events.columns[2]?.renderedType).toBe("jsonb")
  })

  it("reports an attached partition child as a separate regular table", async () => {
    const catalogue = await readCatalogue()
    const child = findTable(findSchema(catalogue, APP_SCHEMA), "events_2026")

    // Attached partitions have pg_class.relkind 'r'; until partition
    // classification lands, the catalogue reports them as regular tables
    // (see CONTRACTS.md and the PR design notes).
    expect(child.kind).toBe("regular")
    expect(child.columns.map((c) => c.name)).toEqual([
      "id",
      "occurred_at",
      "payload",
    ])
  })

  it("preserves domain identity and the immediate base type", async () => {
    const catalogue = await readCatalogue()
    const table = findTable(findSchema(catalogue, APP_SCHEMA), "articles")
    const postal = findColumn(table, "postal")

    expect(postal).toMatchObject({
      isNullable: true,
      defaultExpression: "('12345'::text)::v0201_app.postal_code",
      renderedType: "v0201_app.postal_code",
      type: { schema: "v0201_app", name: "postal_code", kind: "domain" },
      baseType: { schema: "pg_catalog", name: "text", kind: "base" },
    })
  })

  it("renders deterministically even when caller search_path makes a user domain visible", async () => {
    const baseline = await readCatalogue()
    const baselinePostal = findColumn(
      findTable(findSchema(baseline, APP_SCHEMA), "articles"),
      "postal",
    )

    const client = new pg.Client({ connectionString: adminDatabaseUrl })
    await client.connect()
    try {
      await client.query(`SET search_path TO ${quoteIdent(APP_SCHEMA)}, public`)

      // The caller session genuinely sees the domain unqualified.
      const visible = await client.query(`
        SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS rendered
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${quoteLiteral(APP_SCHEMA)}
          AND c.relname = 'articles'
          AND a.attname = 'postal'
      `)
      expect(visible.rows[0]?.rendered).toBe("postal_code")

      const reader = createSchemaCatalogueReader({
        query: ((text: string, values?: unknown[]) =>
          client.query(text, values)) as SchemaCatalogueDependencies["query"],
      })
      const catalogue = await reader.read()
      const postal = findColumn(
        findTable(findSchema(catalogue, APP_SCHEMA), "articles"),
        "postal",
      )

      expect(postal.renderedType).toBe(baselinePostal.renderedType)
      expect(postal.renderedType).toBe("v0201_app.postal_code")
      expect(postal.defaultExpression).toBe(baselinePostal.defaultExpression)

      // The pin is transaction-local: the caller session is untouched.
      const after = await client.query("SHOW search_path")
      expect(after.rows[0]?.search_path).toBe(`${APP_SCHEMA}, public`)
    } finally {
      await client.end()
    }
  })

  it("returns quoted hostile identifiers exactly as data", async () => {
    const catalogue = await readCatalogue()
    const schema = findSchema(catalogue, WEIRD_SCHEMA)
    expect(schema.tables).toHaveLength(1)

    const table = schema.tables[0] as SchemaCatalogueTable
    expect(table.name).toBe('weird "table" name')
    expect(table.columns.map((c) => c.name)).toEqual([
      "sp ace",
      'quo"te',
      "-- DROP TABLE users;",
    ])

    const quoted = table.columns[1] as SchemaCatalogueColumn
    expect(quoted.defaultExpression).toBe("7")

    const commentLike = table.columns[2] as SchemaCatalogueColumn
    expect(commentLike.defaultExpression).toBe("''';--'::text")
    expect(commentLike.renderedType).toBe("text")
  })

  it("excludes views, materialized views, and sequences", async () => {
    const catalogue = await readCatalogue()
    const app = findSchema(catalogue, APP_SCHEMA)
    const names = app.tables.map((table) => table.name)

    expect(names).not.toContain("articles_view")
    expect(names).not.toContain("articles_mv")
    expect(names).not.toContain("articles_seq")
    expect(names.sort()).toEqual([
      "articles",
      "events",
      "events_2026",
      "metrics",
      "no_columns",
    ])
  })

  it("returns deterministic ordering across repeated reads", async () => {
    const first = await readCatalogue()
    const second = await readCatalogue()

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    const names = first.schemas.map((schema) => schema.name)
    expect(names).toEqual([...names].sort())

    for (const schema of first.schemas) {
      const tableNames = schema.tables.map((table) => table.name)
      expect(tableNames).toEqual([...tableNames].sort())
      for (const table of schema.tables) {
        const ordinals = table.columns.map((column) => column.ordinal)
        expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b))
      }
    }
  })

  it("does not mutate the database across repeated reads", async () => {
    const before = await withAdminClient(captureState)

    const reader = await buildReader()
    await reader.read()
    await reader.read()
    await reader.read()

    const after = await withAdminClient(captureState)
    expect(after).toEqual(before)
  })
})

async function buildReader() {
  // Test-only admin connection: the schema-admin production boundary lands
  // in V02-04; this suite uses the established integration harness.
  return createSchemaCatalogueReader({
    query: async (text, values) => {
      return withAdminClient((client) => client.query(text, values))
    },
  })
}

async function readCatalogue(): Promise<SchemaCatalogue> {
  const reader = await buildReader()
  return reader.read()
}
