// Unit tests for the V02-05 schema-operation log semantics.
//
// The SQL boundary is exercised through a small in-memory fake that honours
// the exact statement shapes the repository issues (insert-on-conflict-nothing,
// key/id selects, guarded status updates, listing). Real-PostgreSQL
// replay/concurrency behaviour lives in the integration suite.

import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"
import type pg from "pg"

import {
  computeActorFingerprint,
  computeOperationChecksum,
  createSchemaOperationLog,
  type SchemaOperationLog,
} from "../../../src/database/index.js"

interface FakeRow {
  id: number
  idempotency_key: string
  command_type: string
  command: unknown
  checksum: string
  status: string
  actor_fingerprint: string
  error_code: string | null
  result: unknown
  created_at: Date
  finished_at: Date | null
}

function createFakeStore() {
  const rows = new Map<string, FakeRow>()
  let nextId = 1

  async function query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<pg.QueryResult> {
    if (text.includes("INSERT INTO microjbase.schema_operations")) {
      const key = values[0] as string
      if (rows.has(key)) {
        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }
      }
      const row: FakeRow = {
        id: nextId++,
        idempotency_key: key,
        command_type: values[1] as string,
        command: JSON.parse(values[2] as string),
        checksum: values[3] as string,
        status: "running",
        actor_fingerprint: values[4] as string,
        error_code: null,
        result: null,
        created_at: new Date(),
        finished_at: null,
      }
      rows.set(key, row)
      return {
        rows: [{ ...row }],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      }
    }
    if (text.includes("SET status = 'running'")) {
      const id = values[0] as number
      for (const row of rows.values()) {
        if (row.id === id && row.status === "failed") {
          row.status = "running"
          row.error_code = null
          row.finished_at = null
          return {
            rows: [{ ...row }],
            rowCount: 1,
            command: "",
            oid: 0,
            fields: [],
          }
        }
      }
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }
    }
    if (text.includes("SET status = 'succeeded'")) {
      const id = values[0] as number
      const result = JSON.parse(values[1] as string)
      for (const row of rows.values()) {
        if (row.id === id && row.status === "running") {
          row.status = "succeeded"
          row.result = result
          row.finished_at = new Date()
          return {
            rows: [{ id: row.id }],
            rowCount: 1,
            command: "",
            oid: 0,
            fields: [],
          }
        }
      }
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }
    }
    if (text.includes("SET status = 'failed'")) {
      const id = values[0] as number
      const errorCode = values[1] as string
      for (const row of rows.values()) {
        if (row.id === id && row.status === "running") {
          row.status = "failed"
          row.error_code = errorCode
          row.finished_at = new Date()
          return {
            rows: [{ id: row.id }],
            rowCount: 1,
            command: "",
            oid: 0,
            fields: [],
          }
        }
      }
      return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] }
    }
    if (text.includes("ORDER BY id DESC")) {
      const limit = values[0] as number
      const offset = values[1] as number
      const ordered = [...rows.values()]
        .sort((a, b) => b.id - a.id)
        .slice(offset, offset + limit)
      return {
        rows: ordered.map((row) => ({ ...row })),
        rowCount: ordered.length,
        command: "",
        oid: 0,
        fields: [],
      }
    }
    if (text.includes("WHERE idempotency_key = $1")) {
      const key = values[0] as string
      const row = rows.get(key)
      return {
        rows: row === undefined ? [] : [{ ...row }],
        rowCount: row === undefined ? 0 : 1,
        command: "",
        oid: 0,
        fields: [],
      }
    }
    if (text.includes("WHERE id = $1")) {
      const id = values[0] as number
      const row = [...rows.values()].find((candidate) => candidate.id === id)
      return {
        rows: row === undefined ? [] : [{ ...row }],
        rowCount: row === undefined ? 0 : 1,
        command: "",
        oid: 0,
        fields: [],
      }
    }
    throw new Error(`unexpected SQL in fake: ${text}`)
  }

  return {
    query,
    rows,
    async withLog(fn: (log: SchemaOperationLog) => Promise<void>) {
      await fn(createSchemaOperationLog({ query }))
    },
  }
}

const BASE_INPUT = {
  idempotencyKey: "op-001",
  commandType: "schema.table.create",
  command: { schema: "public", table: "notes" },
  actor: "operator",
}

describe("computeOperationChecksum", () => {
  it("is stable regardless of JSON key order", () => {
    const a = computeOperationChecksum("schema.table.create", {
      schema: "public",
      table: "notes",
      options: { b: 1, a: 2 },
    })
    const b = computeOperationChecksum("schema.table.create", {
      options: { a: 2, b: 1 },
      table: "notes",
      schema: "public",
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it("differs between command types and payloads", () => {
    const a = computeOperationChecksum("schema.table.create", { table: "a" })
    const b = computeOperationChecksum("schema.table.drop", { table: "a" })
    const c = computeOperationChecksum("schema.table.create", { table: "b" })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it("mixes the sealed statement list into the checksum", () => {
    const commandOnly = computeOperationChecksum("schema.table.create", {
      table: "notes",
    })
    const statementA = computeOperationChecksum(
      "schema.table.create",
      { table: "notes" },
      ['CREATE TABLE "app"."notes" ("id" uuid)'],
    )
    const statementB = computeOperationChecksum(
      "schema.table.create",
      { table: "notes" },
      ['CREATE TABLE "app"."notes" ("id" text)'],
    )
    expect(new Set([commandOnly, statementA, statementB]).size).toBe(3)
  })
})

describe("computeActorFingerprint", () => {
  it("is deterministic and case-insensitive", () => {
    expect(computeActorFingerprint("Operator")).toBe(
      computeActorFingerprint("operator"),
    )
  })

  it("does not contain the raw actor label", () => {
    const fingerprint = computeActorFingerprint("operator-secret-label")
    expect(fingerprint).not.toContain("operator-secret-label")
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is a keyed HMAC, not a digest of the public prefix", () => {
    const fingerprint = computeActorFingerprint("operator")
    const publicPrefixDigest = createHash("sha256")
      .update("v1|actor|operator", "utf8")
      .digest("hex")
    expect(fingerprint).not.toBe(publicPrefixDigest)
  })
})

describe("createSchemaOperationLog", () => {
  it("accepts a fresh key, then replays a succeeded record", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      const first = await log.begin(BASE_INPUT)
      expect(first.kind).toBe("accepted")
      if (first.kind !== "accepted") return
      expect(first.retryOfFailure).toBe(false)

      await log.succeed(first.record.id, { statementCount: 1 })

      const second = await log.begin(BASE_INPUT)
      expect(second.kind).toBe("replay")
      if (second.kind === "replay") {
        expect(second.record.status).toBe("succeeded")
        expect(second.record.result).toEqual({ statementCount: 1 })
      }
      expect(store.rows.size).toBe(1)
    })
  })

  it("conflicts when the key is reused with a different command", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      await log.succeed((await log.begin(BASE_INPUT)).record.id, null)
      await expect(
        log.begin({
          ...BASE_INPUT,
          command: { schema: "public", table: "other" },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    })
  })

  it("allows retrying a failed record and marks it succeeded", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      const first = await log.begin(BASE_INPUT)
      if (first.kind !== "accepted") throw new Error("expected accepted")
      await log.fail(first.record.id, "INTERNAL_ERROR")

      const retry = await log.begin(BASE_INPUT)
      expect(retry.kind).toBe("accepted")
      if (retry.kind !== "accepted") return
      expect(retry.retryOfFailure).toBe(true)
      expect(retry.record.id).toBe(first.record.id)
      expect(retry.record.status).toBe("running")

      await log.succeed(retry.record.id, { statementCount: 2 })
      const after = await log.get(BASE_INPUT.idempotencyKey)
      expect(after?.status).toBe("succeeded")
    })
  })

  it("reports in_progress for a running record instead of double-executing", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      const first = await log.begin(BASE_INPUT)
      expect(first.kind).toBe("accepted")
      const second = await log.begin(BASE_INPUT)
      expect(second.kind).toBe("in_progress")
    })
  })

  it("stores a fingerprint instead of the raw actor label", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      await log.begin({ ...BASE_INPUT, actor: "raw-secret-actor-label" })
      const stored = [...store.rows.values()][0]
      expect(stored?.actor_fingerprint).toBe(
        computeActorFingerprint("raw-secret-actor-label"),
      )
      expect(JSON.stringify(stored)).not.toContain("raw-secret-actor-label")
    })
  })

  it("validates inputs before touching the database", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      await expect(
        log.begin({ ...BASE_INPUT, idempotencyKey: "bad key!" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
      await expect(
        log.begin({ ...BASE_INPUT, idempotencyKey: "x".repeat(201) }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
      await expect(
        log.begin({ ...BASE_INPUT, commandType: "NOT A TYPE" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
      await expect(
        log.begin({ ...BASE_INPUT, command: [1, 2, 3] }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
      await expect(
        log.begin({ ...BASE_INPUT, actor: "   " }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
      await expect(log.fail(1, "lowercase-code")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      })
      expect(store.rows.size).toBe(0)
    })
  })

  it("lists records newest-first with pagination", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      for (let index = 0; index < 5; index += 1) {
        const outcome = await log.begin({
          ...BASE_INPUT,
          idempotencyKey: `op-${String(index).padStart(3, "0")}`,
        })
        if (outcome.kind === "accepted") {
          await log.succeed(outcome.record.id, null)
        }
      }
      const page = await log.list({ limit: 2, offset: 0 })
      expect(page.map((record) => record.idempotencyKey)).toEqual([
        "op-004",
        "op-003",
      ])
      expect(page[0]?.status).toBe("succeeded")
    })
  })

  it("fail maps to a durable failed record with the stable error code", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      const outcome = await log.begin(BASE_INPUT)
      if (outcome.kind !== "accepted") throw new Error("expected accepted")
      const failed = await log.fail(outcome.record.id, "CONFLICT")
      expect(failed.status).toBe("failed")
      expect(failed.errorCode).toBe("CONFLICT")
      expect(failed.finishedAt).toBeInstanceOf(Date)
    })
  })

  it("succeed refuses to move a non-running record", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      const outcome = await log.begin(BASE_INPUT)
      if (outcome.kind !== "accepted") throw new Error("expected accepted")
      await log.succeed(outcome.record.id, null)
      await expect(log.succeed(outcome.record.id, null)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      })
    })
  })

  it("fails closed on malformed stored rows", async () => {
    const store = createFakeStore()
    await store.withLog(async (log) => {
      await log.begin(BASE_INPUT)
      const stored = [...store.rows.values()][0]
      if (stored) stored.status = "mystery"
      await expect(log.get(BASE_INPUT.idempotencyKey)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      })
    })
  })
})
