// Integration tests for the V02-05 durable schema-operation log against real
// PostgreSQL: persistence, replay, conflict, retry, concurrency, and actor
// fingerprint redaction.

import { createHash } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  checkSchemaOperationLogWriteAccess,
  computeActorFingerprint,
  createPool,
  createSchemaOperationLog,
  type SchemaOperationLog,
} from "../../../src/database/index.js"
import { applyMigrationsAndGrants, withClient } from "./bootstrap.js"
import { quoteIdentifier } from "./helpers.js"

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

const LOG_ROLE = "mjb_v0205_admin"
const LOG_ROLE_PASSWORD = "v0205_admin_password"

function logRoleUrl(): string {
  const url = new URL(adminDatabaseUrl as string)
  url.username = LOG_ROLE
  url.password = LOG_ROLE_PASSWORD
  return url.toString()
}

let pool: ReturnType<typeof createPool>
let log: SchemaOperationLog

beforeAll(async () => {
  await applyMigrationsAndGrants(
    adminDatabaseUrl as string,
    new URL(databaseUrl as string).username,
  )

  await withClient(adminDatabaseUrl as string, async (admin) => {
    // The suite owns the v0205- key namespace; clear leftovers from previous
    // runs so durable history never poisons fixed test keys.
    await admin.query(
      `DELETE FROM microjbase.schema_operations WHERE idempotency_key LIKE 'v0205-%'`,
    )
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(LOG_ROLE)}`)
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(LOG_ROLE)} WITH LOGIN PASSWORD '${LOG_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
    )
    await admin.query(
      `GRANT USAGE ON SCHEMA microjbase TO ${quoteIdentifier(LOG_ROLE)}`,
    )
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON microjbase.schema_operations TO ${quoteIdentifier(LOG_ROLE)}`,
    )
    await admin.query(
      `GRANT USAGE ON SEQUENCE microjbase.schema_operations_id_seq TO ${quoteIdentifier(LOG_ROLE)}`,
    )
  })

  pool = createPool({ databaseUrl: logRoleUrl(), maxConnections: 8 })
  log = createSchemaOperationLog({
    query: (text, values) => pool.query(text, values),
  })
})

afterAll(async () => {
  await pool.close()
  await withClient(adminDatabaseUrl as string, async (admin) => {
    await admin.query(
      `REVOKE ALL ON microjbase.schema_operations FROM ${quoteIdentifier(LOG_ROLE)}`,
    )
    await admin.query(
      `REVOKE ALL ON SEQUENCE microjbase.schema_operations_id_seq FROM ${quoteIdentifier(LOG_ROLE)}`,
    )
    await admin.query(
      `REVOKE USAGE ON SCHEMA microjbase FROM ${quoteIdentifier(LOG_ROLE)}`,
    )
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(LOG_ROLE)}`)
  })
})

const BASE = {
  idempotencyKey: "v0205-op-1",
  commandType: "schema.table.create",
  command: { schema: "app", table: "notes" },
  actor: "operator-session-7f3a",
}

describe("schema operation log against real PostgreSQL", () => {
  it("persists a durable record and replays it after success", async () => {
    const first = await log.begin({
      ...BASE,
      idempotencyKey: "v0205-persist-1",
    })
    expect(first.kind).toBe("accepted")
    if (first.kind !== "accepted") return
    expect(first.record.status).toBe("running")
    expect(first.record.createdAt).toBeInstanceOf(Date)

    await log.succeed(first.record.id, { statementCount: 1 })
    const replayed = await log.begin({
      ...BASE,
      idempotencyKey: "v0205-persist-1",
    })
    expect(replayed.kind).toBe("replay")
    if (replayed.kind === "replay") {
      expect(replayed.record.result).toEqual({ statementCount: 1 })
      expect(replayed.record.finishedAt).toBeInstanceOf(Date)
    }
  })

  it("conflicts when a used key is replayed with a different command", async () => {
    const outcome = await log.begin({
      ...BASE,
      idempotencyKey: "v0205-conflict-1",
    })
    if (outcome.kind === "accepted") {
      await log.succeed(outcome.record.id, null)
    }
    await expect(
      log.begin({
        ...BASE,
        idempotencyKey: "v0205-conflict-1",
        command: { schema: "app", table: "other" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("allows retrying a failed record and keeps exactly one row", async () => {
    const key = "v0205-retry-1"
    const first = await log.begin({ ...BASE, idempotencyKey: key })
    if (first.kind !== "accepted") throw new Error("expected accepted")
    const failed = await log.fail(first.record.id, "CONFLICT")
    expect(failed.status).toBe("failed")
    expect(failed.errorCode).toBe("CONFLICT")

    const retry = await log.begin({ ...BASE, idempotencyKey: key })
    expect(retry.kind).toBe("accepted")
    if (retry.kind !== "accepted") return
    expect(retry.retryOfFailure).toBe(true)
    expect(retry.record.id).toBe(first.record.id)
    await log.succeed(retry.record.id, { statementCount: 3 })

    await withClient(adminDatabaseUrl as string, async (admin) => {
      const count = await admin.query(
        `SELECT count(*)::int AS count FROM microjbase.schema_operations WHERE idempotency_key = 'v0205-retry-1'`,
      )
      expect(count.rows[0]?.count).toBe(1)
    })
  })

  it("serializes concurrent begins: exactly one caller wins the key", async () => {
    const key = "v0205-race-1"
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        log.begin({ ...BASE, idempotencyKey: key }),
      ),
    )
    const accepted = outcomes.filter((outcome) => outcome.kind === "accepted")
    const inProgress = outcomes.filter(
      (outcome) => outcome.kind === "in_progress",
    )
    expect(accepted).toHaveLength(1)
    expect(inProgress).toHaveLength(7)

    if (accepted[0]?.kind === "accepted") {
      await log.succeed(accepted[0].record.id, null)
    }
    const after = await log.begin({ ...BASE, idempotencyKey: key })
    expect(after.kind).toBe("replay")
  })

  it("concurrent begins after success all replay without re-executing", async () => {
    const key = "v0205-race-settled"
    const first = await log.begin({ ...BASE, idempotencyKey: key })
    if (first.kind === "accepted") {
      await log.succeed(first.record.id, { statementCount: 1 })
    }
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        log.begin({ ...BASE, idempotencyKey: key }),
      ),
    )
    expect(outcomes.every((outcome) => outcome.kind === "replay")).toBe(true)
  })

  it("stores only the salted actor fingerprint, never the raw label", async () => {
    const actor = "raw-secret-operator-label-v0205"
    const key = "v0205-fingerprint-1"
    await log.begin({ ...BASE, idempotencyKey: key, actor })

    await withClient(adminDatabaseUrl as string, async (admin) => {
      const result = await admin.query<{
        actor_fingerprint: string
        all_text: string
      }>(
        `SELECT actor_fingerprint,
                concat_ws('|', idempotency_key, command_type, command::text, checksum, status, actor_fingerprint, coalesce(error_code, ''), coalesce(result::text, '')) AS all_text
         FROM microjbase.schema_operations WHERE idempotency_key = '${key}'`,
      )
      const row = result.rows[0]
      expect(row).toBeDefined()
      expect(row?.actor_fingerprint).toBe(computeActorFingerprint(actor))
      // The fingerprint is a keyed HMAC, not a public-prefix digest an
      // attacker could recompute for a guessed actor label.
      const publicPrefixDigest = createHash("sha256")
        .update(`v1|actor|${actor}`, "utf8")
        .digest("hex")
      expect(row?.actor_fingerprint).not.toBe(publicPrefixDigest)
      expect(row?.all_text).not.toContain(actor)
    })
  })

  it("the schema-admin lane can write history with the standard grants", async () => {
    const client = await pool.connect()
    try {
      await expect(
        checkSchemaOperationLogWriteAccess(client),
      ).resolves.toBeUndefined()
    } finally {
      client.release()
    }
  })

  it("a role without grants fails the startup probe with a clear message", async () => {
    const NO_GRANTS_ROLE = "mjb_v0205_nogrants"
    await withClient(adminDatabaseUrl as string, async (admin) => {
      // The role may survive a previous interrupted run holding its schema
      // grant, which blocks DROP ROLE until revoked.
      await admin.query(
        `DO $do$
           BEGIN
             IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${NO_GRANTS_ROLE}') THEN
               EXECUTE format('REVOKE ALL ON SCHEMA microjbase FROM %I', '${NO_GRANTS_ROLE}');
               EXECUTE format('DROP ROLE %I', '${NO_GRANTS_ROLE}');
             END IF;
           END
         $do$`,
      )
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(NO_GRANTS_ROLE)} WITH LOGIN PASSWORD 'nogrants_password' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
      )
      // A real admin lane always holds USAGE on the microjbase schema; the
      // probe targets the table and sequence grants only.
      await admin.query(
        `GRANT USAGE ON SCHEMA microjbase TO ${quoteIdentifier(NO_GRANTS_ROLE)}`,
      )
    })
    const probeUrl = new URL(adminDatabaseUrl as string)
    probeUrl.username = NO_GRANTS_ROLE
    probeUrl.password = "nogrants_password"
    const probePool = createPool({
      databaseUrl: probeUrl.toString(),
      maxConnections: 2,
    })
    try {
      const client = await probePool.connect()
      try {
        await expect(
          checkSchemaOperationLogWriteAccess(client),
        ).rejects.toThrow(
          "missing required privilege INSERT on microjbase.schema_operations",
        )
        await expect(
          checkSchemaOperationLogWriteAccess(client),
        ).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", status: 503 })
      } finally {
        client.release()
      }
    } finally {
      await probePool.close()
      await withClient(adminDatabaseUrl as string, async (admin) => {
        await admin.query(
          `REVOKE ALL ON SCHEMA microjbase FROM ${quoteIdentifier(NO_GRANTS_ROLE)}`,
        )
        await admin.query(
          `DROP ROLE IF EXISTS ${quoteIdentifier(NO_GRANTS_ROLE)}`,
        )
      })
    }
  })

  it("lists history newest-first", async () => {
    for (let index = 0; index < 3; index += 1) {
      const key = `v0205-list-${String(index)}`
      const outcome = await log.begin({
        ...BASE,
        idempotencyKey: key,
        command: { index },
      })
      if (outcome.kind === "accepted") {
        await log.succeed(outcome.record.id, null)
      }
    }
    const page = await log.list({ limit: 3, offset: 0 })
    const keys = page.map((record) => record.idempotencyKey)
    expect(keys).toContain("v0205-list-2")
    expect(keys[0]).toBe("v0205-list-2")
    expect(page.every((record) => record.status === "succeeded")).toBe(true)
  })
})
