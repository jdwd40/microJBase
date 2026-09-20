// Composition root for microJBase v0.1.
//
// Parses configuration once, creates the bounded PostgreSQL pool, verifies
// runtime role safety, builds the configured table registry, creates the auth
// and data services, constructs the Fastify HTTP server, listens on the
// configured host/port, and installs graceful shutdown handlers.
//
// Migrations are NOT run automatically at startup; the operator must apply
// them beforehand with `npm run migrate` using a privileged role.

import { pathToFileURL } from "node:url"

import type { FastifyInstance } from "fastify"

import { parseConfig, safeConfigForLogging } from "./core/config.js"
import { AppError, installShutdownHandlers } from "./core/index.js"
import { createAuthService } from "./auth/index.js"
import { createDataService } from "./data/index.js"
import {
  checkApplicablePolicies,
  checkRuntimeRoleSafety,
  checkRuntimeTablePrivileges,
  checkTableOwnershipAndRls,
  createAuthRepository,
  createPool,
  createPostgresDataRepository,
  createTransactionRunner,
  buildTableRegistry,
  type Pool,
} from "./database/index.js"
import {
  buildServer as buildHttpServer,
  type ServerDependencies,
} from "./http/server.js"

interface StartedServer {
  app: FastifyInstance
  pool: Pool
}

export function buildServer(
  deps: ServerDependencies,
): Promise<FastifyInstance> {
  return buildHttpServer(deps)
}

export async function start(): Promise<StartedServer> {
  const config = parseConfig()

  const pool = createPool({
    databaseUrl: config.databaseUrl,
    maxConnections: 10,
  })

  let started: StartedServer | undefined
  try {
    await assertRuntimeRoleSafety(pool)
    await assertExposedTableSafety(pool, config.tables)

    const registry = await buildTableRegistry(
      { mappings: config.tables },
      { query: (text, values) => pool.query(text, values) },
    )

    const authRepository = createAuthRepository(pool)
    const authService = createAuthService(authRepository, {
      sessionTtlSeconds: config.sessionTtlSeconds,
    })

    const transactionRunner = createTransactionRunner(() => pool.connect())
    const dataRepository = createPostgresDataRepository({
      runner: transactionRunner,
    })
    const dataService = createDataService(registry, dataRepository)

    const app = await buildHttpServer(
      { authService, dataService, pool },
      {
        trustProxy: config.trustProxy,
        maxBodyBytes: config.maxBodyBytes,
        logLevel: config.logLevel,
      },
    )

    await app.listen({ host: config.host, port: config.port })

    app.log.info(
      {
        config: safeConfigForLogging(config),
        host: config.host,
        port: config.port,
      },
      "Server listening",
    )

    installShutdownHandlers([
      {
        close: async () => {
          await app.close()
          await pool.close()
        },
      },
    ])

    started = { app, pool }
    return started
  } catch (error: unknown) {
    // If startup fails after creating the pool, close it before propagating
    // so we do not leak connections.
    try {
      await pool.close()
    } catch {
      // Ignore secondary close errors; original error is what matters.
    }
    throw error
  }
}

async function assertRuntimeRoleSafety(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await checkRuntimeRoleSafety(client)
  } finally {
    client.release()
  }
}

async function assertExposedTableSafety(
  pool: Pool,
  tables: readonly { schema: string; table: string }[],
): Promise<void> {
  if (tables.length === 0) {
    return
  }

  const client = await pool.connect()
  try {
    await checkTableOwnershipAndRls(client, tables)
    await checkRuntimeTablePrivileges(client, tables)
    await checkApplicablePolicies(client, tables)
  } finally {
    client.release()
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  start().catch((error: unknown) => {
    const appError =
      error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "An unexpected error occurred", 500)
    console.error(
      JSON.stringify({
        level: "error",
        code: appError.code,
        message: appError.message,
      }),
    )
    process.exitCode = 1
  })
}
