import { createHash } from "node:crypto"
import {
  generateSessionToken,
  hashRawToken,
  parseRawToken,
} from "./auth/index.js"
import { AppError } from "./core/index.js"
import {
  createDataService,
  DataError,
  isCanonicalUuid,
  type DataService,
} from "./data/index.js"
import {
  buildTableRegistry,
  createPostgresDataRepository,
  quoteIdentifier,
  type TransactionRunner,
} from "./database/index.js"

export interface ApplicationAccess {
  exchange(app: string, bearer: string | null): Promise<string>
  handoff(
    app: string,
    bearer: string | null,
    input: unknown,
    redeem: boolean,
  ): Promise<string>
  setMember(
    app: string,
    bearer: string | null,
    user: string,
    grant: boolean,
  ): Promise<void>
  catalogue(app: string, bearer: string | null): Promise<unknown[]>
  visibility(
    app: string,
    bearer: string | null,
    alias: string,
    visible: boolean,
  ): Promise<void>
  run<T>(
    app: string,
    bearer: string | null,
    alias: string,
    operation: (
      service: DataService,
      identity: { userId: string },
    ) => Promise<T>,
  ): Promise<T>
}
function denied() {
  return new AppError("AUTH_REQUIRED", "Application access required", 401)
}
function credential(app: string, bearer: string | null) {
  const digest = bearer && hashRawToken(bearer)
  if (!digest || !isCanonicalUuid(app)) throw denied()
  return digest
}

export function createApplicationAccess(
  runner: TransactionRunner,
): ApplicationAccess {
  return {
    async exchange(app, bearer) {
      const digest = credential(app, bearer)
      const next = generateSessionToken()
      return runner.withTransaction(async ({ query }) => {
        const result = await query(
          "SELECT microjbase.exchange_application_session($1,$2,$3) AS ok",
          [app, digest, next.tokenHash],
        )
        if (result.rows[0]?.ok !== true) throw denied()
        return next.rawToken
      })
    },
    async handoff(app, bearer, input, redeem) {
      if (
        !input ||
        typeof input !== "object" ||
        !("callback" in input) ||
        typeof input.callback !== "string" ||
        input.callback.length > 2048
      )
        throw denied()
      const callback = input.callback
      const challenge = redeem
        ? "verifier" in input &&
          typeof input.verifier === "string" &&
          /^[a-zA-Z0-9._~-]{43,128}$/.test(input.verifier) &&
          createHash("sha256").update(input.verifier).digest()
        : "challenge" in input &&
          typeof input.challenge === "string" &&
          parseRawToken(input.challenge)
      if (!challenge) throw denied()
      const proof = credential(app, bearer)
      const next = generateSessionToken()
      return runner.withTransaction(async ({ query }) => {
        const result = await query(
          redeem
            ? "SELECT microjbase.redeem_application_code($1,$2,$3,$4,$5) AS ok"
            : "SELECT microjbase.issue_application_code($1,$2,$3,$4,$5) AS ok",
          [app, proof, next.tokenHash, callback, challenge],
        )
        if (result.rows[0]?.ok !== true) throw denied()
        return next.rawToken
      })
    },
    async setMember(app, bearer, user, grant) {
      const proof = credential(app, bearer)
      if (!isCanonicalUuid(user)) throw denied()
      await runner.withTransaction(async ({ query }) => {
        const result = await query(
          "SELECT microjbase.set_application_member($1,$2,$3,$4) AS ok",
          [app, proof, user, grant],
        )
        if (result.rows[0]?.ok !== true) throw denied()
      })
    },
    async catalogue(app, bearer) {
      const proof = credential(app, bearer)
      return runner.withTransaction(async ({ query }) => {
        const result = await query(
          "SELECT microjbase.application_catalogue($1,$2) AS tables",
          [app, proof],
        )
        const tables = result.rows[0]?.tables
        if (!Array.isArray(tables)) throw denied()
        return tables
      })
    },
    async visibility(app, bearer, alias, visible) {
      const proof = credential(app, bearer)
      await runner.withTransaction(async ({ query }) => {
        const result = await query(
          "SELECT microjbase.set_application_visibility($1,$2,$3,$4) AS ok",
          [app, proof, alias, visible],
        )
        if (result.rows[0]?.ok !== true) throw denied()
      })
    },
    async run(app, bearer, alias, operation) {
      const digest = credential(app, bearer)
      return runner.withTransaction(async (ctx) => {
        const subject = await ctx.query<{ user_id: string }>(
          "SELECT user_id FROM microjbase.authenticate_application($1,$2)",
          [app, digest],
        )
        const userId = subject.rows[0]?.user_id
        if (!userId) throw denied()
        const result = await ctx.query<{
          schema_name: string
          table_name: string
        }>("SELECT * FROM microjbase.resolve_application_table($1)", [alias])
        const target = result.rows[0]
        if (!target)
          throw new AppError("TABLE_NOT_FOUND", "Table not found", 404)
        // Hold the table stable from policy verification through the data operation.
        await ctx.query(
          `LOCK TABLE ONLY ${quoteIdentifier(target.schema_name)}.${quoteIdentifier(target.table_name)} IN ACCESS SHARE MODE`,
        )
        const boundary = await ctx.query(
          `SELECT 1 FROM pg_catalog.pg_class t
             JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
             JOIN pg_catalog.pg_policy p ON p.polrelid=t.oid
            WHERE n.nspname=$1 AND t.relname=$2 AND t.relkind='r'
              AND t.relrowsecurity AND t.relforcerowsecurity
              AND p.polname='microjbase_application_boundary'
              AND NOT p.polpermissive AND p.polcmd='*' AND p.polroles=ARRAY[0::oid]
              AND NOT EXISTS (SELECT FROM pg_catalog.pg_inherits i WHERE t.oid IN (i.inhparent,i.inhrelid))
              AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_constraint fk
                JOIN pg_catalog.pg_class other ON other.oid=CASE WHEN fk.conrelid=t.oid THEN fk.confrelid ELSE fk.conrelid END
                WHERE fk.contype='f' AND t.oid IN (fk.conrelid,fk.confrelid)
                  AND other.relnamespace<>t.relnamespace
                  AND NOT (fk.conrelid=t.oid AND fk.confrelid='microjbase.users'::regclass)
              )`,
          [target.schema_name, target.table_name],
        )
        if (!boundary.rowCount)
          throw new AppError("TABLE_NOT_FOUND", "Table not found", 404)
        const registry = await buildTableRegistry(
          {
            mappings: [
              { alias, schema: target.schema_name, table: target.table_name },
            ],
          },
          ctx,
        )
        const service = createDataService(
          registry,
          createPostgresDataRepository({
            runner: { withTransaction: (block) => block(ctx) },
          }),
        )
        try {
          return await operation(service, { userId })
        } catch (err) {
          if (err instanceof DataError)
            throw new AppError(err.code, err.message, err.status, err.details)
          throw err
        }
      })
    },
  }
}
