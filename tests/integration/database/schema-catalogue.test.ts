import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"

import { createSchemaCatalogueReader } from "../../../src/database/index.js"
import type {
  SchemaCatalogue,
  SchemaCatalogueColumn,
  SchemaCatalogueSchema,
  SchemaCatalogueTable,
} from "../../../src/contracts/index.js"
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

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>) {
  return withClient(adminDatabaseUrl as string, fn)
}

async function createFixtures(): Promise<void> {
  await withAdminClient(async (admin) => {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteLit(WEIRD_SCHEMA)} CASCADE`)
    await admin.query(`DROP SCHEMA IF EXISTS ${APP_SCHEMA} CASCADE`)
    await admin.query(`DROP SCHEMA IF EXISTS ${EMPTY_SCHEMA} CASCADE`)

    await admin.query(`CREATE SCHEMA ${quoteLit(EMPTY_SCHEMA)}`)
    await admin.query(`CREATE SCHEMA ${APP_SCHEMA}`)
    await admin.query(
      `CREATE DOMAIN ${APP_SCHEMA}.postal_code AS text CHECK (VALUE ~ '^[0-9]{5}$')`,
    )
    await admin.query(`
      CREATE TABLE ${APP_SCHEMA}.articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        body text,
        priority integer NOT NULL DEFAULT 42,
        created_at timestamptz NOT NULL DEFAULT now(),
        seq integer GENERATED ALWAYS AS IDENTITY,
        slug_length integer GENERATED ALWAYS AS (length(title)) STORED,
        postal ${APP_SCHEMA}.postal_code DEFAULT '12345'::${APP_SCHEMA}.postal_code
      )
    `)
    await admin.query(`
      CREATE TABLE ${APP_SCHEMA}.metrics (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid,
        value integer
      )
    `)
    await admin.query(
      `ALTER TABLE ${APP_SCHEMA}.metrics ENABLE ROW LEVEL SECURITY`,
    )
    await admin.query(
      `ALTER TABLE ${APP_SCHEMA}.metrics FORCE ROW LEVEL SECURITY`,
    )
    await admin.query(`
      CREATE TABLE ${APP_SCHEMA}.events (
        id uuid NOT NULL,
        occurred_at timestamptz NOT NULL,
        payload jsonb
      ) PARTITION BY RANGE (occurred_at)
    `)

    // Non-table objects must never appear in the catalogue.
    await admin.query(
      `CREATE VIEW ${APP_SCHEMA}.articles_view AS SELECT id, title FROM ${APP_SCHEMA}.articles`,
    )
    await admin.query(`
      CREATE MATERIALIZED VIEW ${APP_SCHEMA}.articles_mv AS
      SELECT id, title FROM ${APP_SCHEMA}.articles
    `)
    await admin.query(`CREATE SEQUENCE ${APP_SCHEMA}.articles_seq`)

    await admin.query(`CREATE SCHEMA ${quoteLit(WEIRD_SCHEMA)}`)
    await admin.query(`
      CREATE TABLE ${quoteLit(WEIRD_SCHEMA)}.${quoteLit('weird "table" name')} (
        ${quoteLit("sp ace")} text,
        ${quoteLit('quo"te')} integer DEFAULT 7,
        ${quoteLit("-- DROP TABLE users;")} text DEFAULT ''';--'
      )
    `)
  })
}

async function dropFixtures(): Promise<void> {
  await withAdminClient(async (admin) => {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteLit(WEIRD_SCHEMA)} CASCADE`)
    await admin.query(`DROP SCHEMA IF EXISTS ${APP_SCHEMA} CASCADE`)
    await admin.query(`DROP SCHEMA IF EXISTS ${EMPTY_SCHEMA} CASCADE`)
  })
}

// Test-only identifier quoting for fixture DDL. Fixture names above are
// fixed, but quoting stays defensive so the setup cannot be diverted.
function quoteLit(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

interface CatalogueState {
  objects: unknown[]
  domains: unknown[]
  migrations: unknown[]
  fixtureData: unknown[]
}

async function captureState(admin: pg.Client): Promise<CatalogueState> {
  const objects = await admin.query(`
    SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity,
           c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN (${FIXTURE_SCHEMAS.map((s) => `'${s}'`).join(",")})
    ORDER BY n.nspname, c.relname
  `)
  const domains = await admin.query(`
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = '${APP_SCHEMA}' AND t.typtype = 'd'
    ORDER BY t.typname
  `)
  const migrations = await admin.query(`
    SELECT filename, checksum, applied_at
    FROM microjbase.schema_migrations
    ORDER BY filename
  `)
  const articles = await admin.query(
    `SELECT * FROM ${APP_SCHEMA}.articles ORDER BY id`,
  )
  const metrics = await admin.query(
    `SELECT * FROM ${APP_SCHEMA}.metrics ORDER BY id`,
  )
  const events = await admin.query(
    `SELECT * FROM ${APP_SCHEMA}.events ORDER BY id`,
  )
  const weird = await admin.query(
    `SELECT * FROM ${quoteLit(WEIRD_SCHEMA)}.${quoteLit('weird "table" name')}`,
  )
  return {
    objects: objects.rows,
    domains: domains.rows,
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

  it("represents ordinary tables with accurate column metadata", async () => {
    const catalogue = await readCatalogue()
    const table = findTable(findSchema(catalogue, APP_SCHEMA), "articles")

    expect(table.kind).toBe("regular")
    expect(table.owner).toBe("microjbase")
    expect(table.hasRowSecurity).toBe(false)
    expect(table.hasForcedRowSecurity).toBe(false)

    const byName = new Map(table.columns.map((c) => [c.name, c]))
    expect(table.columns.map((c) => c.name)).toEqual([
      "id",
      "title",
      "body",
      "priority",
      "created_at",
      "seq",
      "slug_length",
      "postal",
    ])
    expect(table.columns.map((c) => c.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])

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

  it("preserves domain identity and underlying base type", async () => {
    const catalogue = await readCatalogue()
    const table = findTable(findSchema(catalogue, APP_SCHEMA), "articles")
    const postal = table.columns.find((c) => c.name === "postal")

    expect(postal).toMatchObject({
      isNullable: true,
      defaultExpression: "('12345'::text)::v0201_app.postal_code",
      renderedType: "v0201_app.postal_code",
      type: { schema: "v0201_app", name: "postal_code", kind: "domain" },
      baseType: { schema: "pg_catalog", name: "text", kind: "base" },
    })
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
    expect(names.sort()).toEqual(["articles", "events", "metrics"])
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
