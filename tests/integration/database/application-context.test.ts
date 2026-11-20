import pg from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  applyMigrationsAndGrants,
  cleanMigrations,
  withClient,
} from "./bootstrap.js"
import { quoteIdentifier } from "./helpers.js"

const admin = process.env.INTEGRATION_ADMIN_DATABASE_URL!
const runtime = process.env.INTEGRATION_DATABASE_URL!
const pool = new pg.Pool({ connectionString: runtime, max: 1 })
const user = "e91a354d-cffb-48b2-9056-c2bc8289e63b"
const a = "85bcff32-23b2-460d-a424-4f3af2191bd8"
const b = "c1df1400-d01d-4f66-b83e-74eb830fc7d2"
const c = "b47796c0-910b-442b-8ca0-92af19a63643"

beforeAll(async () => {
  await cleanMigrations(admin)
  const role = new URL(runtime).username
  await applyMigrationsAndGrants(admin, role)
  await withClient(admin, async (db) => {
    await db.query(
      `GRANT EXECUTE ON FUNCTION microjbase.bind_application(uuid,uuid), microjbase.resolve_application_table(text) TO ${quoteIdentifier(role)}`,
    )
    await db.query(
      "INSERT INTO microjbase.users(id,email,password_hash) VALUES ($1,'app-test@example.invalid','unused')",
      [user],
    )
    await db.query(
      "INSERT INTO microjbase.applications(id,name,schema_name,enabled,open_to_authenticated) VALUES ($1,'A','app_a',true,false),($2,'B','app_b',true,true),($3,'C','app_c',true,false)",
      [a, b, c],
    )
    await db.query(
      "INSERT INTO microjbase.application_memberships VALUES ($1,$2,'admin')",
      [a, user],
    )
    await db.query(
      "INSERT INTO microjbase.application_exposures VALUES ($1,'items','items'),($2,'items','items'),($3,'items','items')",
      [a, b, c],
    )
  })
})
afterAll(async () => {
  await pool.end()
  await cleanMigrations(admin)
})

async function scope(app: string, finish: "COMMIT" | "ROLLBACK") {
  const db = await pool.connect()
  try {
    await db.query("BEGIN")
    const before = await db.query(
      "SELECT * FROM microjbase.resolve_application_table('items')",
    )
    expect(before.rows).toEqual([])
    const bind = await db.query(
      "SELECT microjbase.bind_application($1,$2) AS role",
      [app, user],
    )
    const alias = await db.query(
      "SELECT * FROM microjbase.resolve_application_table('items')",
    )
    await db.query(finish)
    return { role: bind.rows[0].role, tables: alias.rows }
  } finally {
    db.release()
  }
}

it("isolates concurrent requests on one pooled connection across commit, rollback and denial", async () => {
  const [privateApp, openApp, denied] = await Promise.all([
    scope(a, "COMMIT"),
    scope(b, "ROLLBACK"),
    scope(c, "COMMIT"),
  ])
  expect(privateApp).toEqual({
    role: "admin",
    tables: [{ schema_name: "app_a", table_name: "items" }],
  })
  expect(openApp).toEqual({
    role: "member",
    tables: [{ schema_name: "app_b", table_name: "items" }],
  })
  expect(denied).toEqual({ role: null, tables: [] })
})
