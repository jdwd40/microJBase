import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"

import {
  createSchemaCatalogueReader,
  type SchemaCatalogueDependencies,
} from "../../../src/database/index.js"
import type {
  SchemaCatalogue,
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

const APP_SCHEMA = "v0202_app"
const HOSTILE_SCHEMA = "v0202 hostile ' ; schema"

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
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdent(HOSTILE_SCHEMA)} CASCADE`,
    )
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(APP_SCHEMA)} CASCADE`)

    await admin.query(`CREATE SCHEMA ${quoteIdent(APP_SCHEMA)}`)
    await admin.query(`
      CREATE TABLE ${quoteIdent(APP_SCHEMA)}.authors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        display_name text
      )
    `)
    await admin.query(`
      ALTER TABLE ${quoteIdent(APP_SCHEMA)}.authors
        ADD CONSTRAINT authors_email_key UNIQUE (email)
    `)
    await admin.query(`
      CREATE TABLE ${quoteIdent(APP_SCHEMA)}.books (
        id uuid NOT NULL,
        author_id uuid,
        title text NOT NULL,
        isbn text,
        price_cents integer,
        room tsrange,
        PRIMARY KEY (id),
        CONSTRAINT books_author_id_fkey
          FOREIGN KEY (author_id)
          REFERENCES ${quoteIdent(APP_SCHEMA)}.authors(id)
          ON UPDATE CASCADE ON DELETE SET NULL,
        CONSTRAINT books_title_check CHECK (char_length(title) > 0),
        CONSTRAINT books_title_key UNIQUE (title),
        EXCLUDE USING gist (room WITH &&)
      )
    `)
    await admin.query(`
      CREATE INDEX books_isbn_idx ON ${quoteIdent(APP_SCHEMA)}.books (isbn)
    `)
    await admin.query(`
      CREATE UNIQUE INDEX books_price_title_uidx
        ON ${quoteIdent(APP_SCHEMA)}.books (price_cents, title)
    `)
    await admin.query(`
      CREATE INDEX books_recent_price_idx
        ON ${quoteIdent(APP_SCHEMA)}.books (author_id)
        WHERE price_cents > 0
    `)
    await admin.query(`
      CREATE INDEX books_lower_title_idx
        ON ${quoteIdent(APP_SCHEMA)}.books (lower(title))
    `)
    await admin.query(`
      CREATE INDEX books_lower_isbn_part_idx
        ON ${quoteIdent(APP_SCHEMA)}.books (lower(isbn))
        WHERE isbn IS NOT NULL
    `)
    // A foreign key referencing the internal microjbase schema must still be
    // reported with its full target; the reference is data, not a claim that
    // the target is manageable.
    await admin.query(`
      CREATE TABLE ${quoteIdent(APP_SCHEMA)}.bookmarks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL
          REFERENCES microjbase.users(id) ON DELETE CASCADE,
        url text NOT NULL
      )
    `)

    await admin.query(`CREATE SCHEMA ${quoteIdent(HOSTILE_SCHEMA)}`)
    await admin.query(`
      CREATE TABLE ${quoteIdent(HOSTILE_SCHEMA)}.${quoteIdent('ta "ble"')} (
        ${quoteIdent("sp ace")} integer,
        ${quoteIdent("-- DROP TABLE users;")} text
      )
    `)
    await admin.query(`
      ALTER TABLE ${quoteIdent(HOSTILE_SCHEMA)}.${quoteIdent('ta "ble"')}
        ADD CONSTRAINT ${quoteIdent('con "straint"; -- DROP')}
        CHECK (${quoteIdent("sp ace")} > 0)
    `)
    await admin.query(`
      CREATE UNIQUE INDEX ${quoteIdent('uni "que"; --')}
        ON ${quoteIdent(HOSTILE_SCHEMA)}.${quoteIdent('ta "ble"')} (${quoteIdent("sp ace")})
    `)
  })
}

async function dropFixtures(): Promise<void> {
  await withAdminClient(async (admin) => {
    await admin.query(
      `DROP SCHEMA IF EXISTS ${quoteIdent(HOSTILE_SCHEMA)} CASCADE`,
    )
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(APP_SCHEMA)} CASCADE`)
  })
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

async function readCatalogue(): Promise<SchemaCatalogue> {
  const reader = createSchemaCatalogueReader({
    query: ((text: string, values?: unknown[]) =>
      withAdminClient((client) =>
        client.query(text, values),
      )) as SchemaCatalogueDependencies["query"],
  })
  return reader.read()
}

describe("schema catalogue constraints and indexes (real PostgreSQL)", () => {
  beforeAll(async () => {
    await cleanMigrations(adminDatabaseUrl)
    await applyMigrationsAndGrants(adminDatabaseUrl, runtimeRoleName)
    await createFixtures()
  })

  afterAll(async () => {
    await dropFixtures()
    await cleanMigrations(adminDatabaseUrl)
  })

  it("reports primary-key and unique constraints with ordered columns", async () => {
    const catalogue = await readCatalogue()
    const app = findSchema(catalogue, APP_SCHEMA)

    expect(findTable(app, "authors").constraints).toEqual([
      {
        name: "authors_email_key",
        classification: "unique",
        columns: ["email"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
      {
        name: "authors_pkey",
        classification: "primary_key",
        columns: ["id"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
    ])
  })

  it("reports foreign keys with referenced target and update/delete actions", async () => {
    const catalogue = await readCatalogue()
    const books = findTable(findSchema(catalogue, APP_SCHEMA), "books")

    const foreignKey = books.constraints.find(
      (constraint) => constraint.classification === "foreign_key",
    )
    expect(foreignKey).toEqual({
      name: "books_author_id_fkey",
      classification: "foreign_key",
      columns: ["author_id"],
      references: {
        schema: APP_SCHEMA,
        table: "authors",
        columns: ["id"],
      },
      onUpdate: "cascade",
      onDelete: "set_null",
    })
  })

  it("reports a foreign key targeting the internal microjbase schema as data", async () => {
    const catalogue = await readCatalogue()
    const bookmarks = findTable(findSchema(catalogue, APP_SCHEMA), "bookmarks")

    expect(bookmarks.constraints).toEqual([
      {
        name: "bookmarks_pkey",
        classification: "primary_key",
        columns: ["id"],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
      {
        name: "bookmarks_user_id_fkey",
        classification: "foreign_key",
        columns: ["user_id"],
        references: {
          schema: "microjbase",
          table: "users",
          columns: ["id"],
        },
        onUpdate: "no_action",
        onDelete: "cascade",
      },
    ])
  })

  it("classifies check and exclusion constraints as read-only metadata", async () => {
    const catalogue = await readCatalogue()
    const books = findTable(findSchema(catalogue, APP_SCHEMA), "books")

    const check = books.constraints.find(
      (constraint) => constraint.classification === "check",
    )
    expect(check).toEqual({
      name: "books_title_check",
      classification: "check",
      // Normalized to an empty list on every server version: PostgreSQL 18
      // populates pg_constraint.conkey for checks while PostgreSQL 16 does
      // not, and the catalogue contract promises no column list.
      columns: [],
      references: null,
      onUpdate: null,
      onDelete: null,
    })

    const exclusion = books.constraints.find(
      (constraint) => constraint.classification === "exclusion",
    )
    expect(exclusion).toEqual({
      name: "books_room_excl",
      classification: "exclusion",
      columns: ["room"],
      references: null,
      onUpdate: null,
      onDelete: null,
    })
  })

  it("reports all constraint kinds on one table in deterministic name order", async () => {
    const catalogue = await readCatalogue()
    const books = findTable(findSchema(catalogue, APP_SCHEMA), "books")

    expect(books.constraints.map((constraint) => constraint.name)).toEqual([
      "books_author_id_fkey",
      "books_pkey",
      "books_room_excl",
      "books_title_check",
      "books_title_key",
    ])
    expect(books.constraints.map((c) => c.classification)).toEqual([
      "foreign_key",
      "primary_key",
      "exclusion",
      "check",
      "unique",
    ])
  })

  it("reports standalone indexes with uniqueness, predicate, and expression flags", async () => {
    const catalogue = await readCatalogue()
    const books = findTable(findSchema(catalogue, APP_SCHEMA), "books")

    expect(books.indexes).toEqual([
      {
        name: "books_isbn_idx",
        classification: "index",
        isUnique: false,
        isExpression: false,
        hasPredicate: false,
        columns: ["isbn"],
      },
      {
        name: "books_lower_isbn_part_idx",
        classification: "expression_index",
        isUnique: false,
        isExpression: true,
        hasPredicate: true,
        columns: [null],
      },
      {
        name: "books_lower_title_idx",
        classification: "expression_index",
        isUnique: false,
        isExpression: true,
        hasPredicate: false,
        columns: [null],
      },
      {
        name: "books_price_title_uidx",
        classification: "index",
        isUnique: true,
        isExpression: false,
        hasPredicate: false,
        columns: ["price_cents", "title"],
      },
      {
        name: "books_recent_price_idx",
        classification: "partial_index",
        isUnique: false,
        isExpression: false,
        hasPredicate: true,
        columns: ["author_id"],
      },
    ])
  })

  it("never double-reports constraint backing indexes", async () => {
    const catalogue = await readCatalogue()
    const app = findSchema(catalogue, APP_SCHEMA)

    // books has a primary key, a unique constraint, and an exclusion
    // constraint, all of which own backing indexes in PostgreSQL; the index
    // list contains only the five standalone indexes created above.
    const books = findTable(app, "books")
    expect(books.indexes.map((index) => index.name)).toEqual([
      "books_isbn_idx",
      "books_lower_isbn_part_idx",
      "books_lower_title_idx",
      "books_price_title_uidx",
      "books_recent_price_idx",
    ])
    for (const index of books.indexes) {
      expect(index.name).not.toBe("books_pkey")
    }

    // The partial index on microjbase.sessions from migration 0002 is a
    // standalone index and must appear; the sessions unique constraint and
    // primary key must not appear as indexes.
    const sessions = findTable(findSchema(catalogue, "microjbase"), "sessions")
    expect(sessions.indexes.map((index) => index.name)).toEqual([
      "idx_sessions_user_id",
    ])
    expect(sessions.indexes[0]).toMatchObject({
      classification: "partial_index",
      hasPredicate: true,
      columns: ["user_id"],
    })
  })

  it("returns hostile constraint and index names exactly as data", async () => {
    const catalogue = await readCatalogue()
    const table = findTable(findSchema(catalogue, HOSTILE_SCHEMA), 'ta "ble"')

    expect(table.constraints).toEqual([
      {
        name: 'con "straint"; -- DROP',
        classification: "check",
        columns: [],
        references: null,
        onUpdate: null,
        onDelete: null,
      },
    ])
    expect(table.indexes).toEqual([
      {
        name: 'uni "que"; --',
        classification: "index",
        isUnique: true,
        isExpression: false,
        hasPredicate: false,
        columns: ["sp ace"],
      },
    ])
  })

  it("keeps constraint and index output deterministic across repeated reads", async () => {
    const first = await readCatalogue()
    const second = await readCatalogue()

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    const app = findSchema(first, APP_SCHEMA)
    const books = findTable(app, "books")
    const constraintNames = books.constraints.map((c) => c.name)
    expect(constraintNames).toEqual([...constraintNames].sort())
    const indexNames = books.indexes.map((i) => i.name)
    expect(indexNames).toEqual([...indexNames].sort())
  })
})
