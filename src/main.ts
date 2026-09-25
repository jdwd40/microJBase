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

import {
  AppError,
  installShutdownHandlers,
  parseConfig,
  safeConfigForLogging,
} from "./core/index.js"
import { createAuthService } from "./auth/index.js"
import { createDataService } from "./data/index.js"
import {
  assertSchemaAdminSessionDistinct,
  checkApplicablePolicies,
  checkRuntimeRoleSafety,
  checkRuntimeTablePrivileges,
  checkSchemaAdminRoleSafety,
  checkSchemaOperationLogWriteAccess,
  checkExposureRegistryWriteAccess,
  checkTableOwnershipAndRls,
  createAuthRepository,
  createPool,
  createPostgresDataRepository,
  createSchemaAdminPool,
  createSchemaCatalogueReader,
  createSchemaDdlExecutor,
  createSchemaExposureService,
  createSchemaOperationLog,
  createTransactionRunner,
  createSwappableTableRegistry,
  buildTableRegistry,
  importInitialExposure,
  readExposureRegistryState,
  type Pool,
  type SchemaExposureService,
} from "./database/index.js"
import {
  buildServer as buildHttpServer,
  type ServerDependencies,
} from "./http/index.js"

interface StartedServer {
  app: FastifyInstance
  pool: Pool
  adminPool: Pool | null
  /** Composed admin-lane services; null when the admin lane is disabled. */
  admin: { exposure: SchemaExposureService } | null
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

  // The schema-admin lane is opt-in (D-012): with neither admin setting
  // configured it never exists, with exactly one parseConfig already failed,
  // and with both configured the pool is created and its role capability
  // checked before the server accepts traffic.
  const adminPool = config.schemaDatabaseUrl
    ? createSchemaAdminPool({ databaseUrl: config.schemaDatabaseUrl })
    : null

  let started: StartedServer | undefined
  try {
    await assertRuntimeRoleSafety(pool)

    // V02-10 (D-018): the durable exposure registry is the sole runtime
    // exposure source. MICROJBASE_TABLES feeds exactly one import on the
    // first startup after migration 0006; afterwards the environment
    // variable can neither add tables nor re-expose an unexposed table.
    const runtimeQuery: Pool["query"] = (text, values) =>
      pool.query(text, values)
    let exposureState = await readExposureRegistryState({ query: runtimeQuery })
    if (!exposureState.initialized) {
      // Validate the configured mappings before the one-time import
      // commits: a bad MICROJBASE_TABLES then fails startup without baking
      // the mistake into the durable registry, and a later restart after
      // fixing the configuration imports cleanly.
      await buildTableRegistry(
        { mappings: config.tables },
        { query: runtimeQuery },
      )
      exposureState = await importInitialExposure(
        { query: runtimeQuery },
        config.tables,
      )
    }

    await assertExposedTableSafety(pool, exposureState.exposed)
    if (adminPool) {
      await assertSchemaAdminRoleSafety(adminPool)
      await assertSchemaAdminHistoryWriteAccess(adminPool)
      await assertSchemaAdminExposureAccess(adminPool)
      await assertSchemaAdminLaneDistinctness(pool, adminPool)
    }

    const registry = createSwappableTableRegistry(
      await buildTableRegistry(
        { mappings: exposureState.exposed },
        { query: runtimeQuery },
      ),
    )

    const refreshRuntimeRegistry = async (): Promise<void> => {
      const state = await readExposureRegistryState({ query: runtimeQuery })
      registry.replace(
        await buildTableRegistry(
          { mappings: state.exposed },
          { query: runtimeQuery },
        ),
      )
    }

    let admin: StartedServer["admin"] = null
    if (adminPool) {
      admin = {
        exposure: createSchemaExposureService({
          pool: adminPool,
          catalogue: createSchemaCatalogueReader({
            query: (text, values) => adminPool.query(text, values),
          }),
          executor: createSchemaDdlExecutor({
            pool: adminPool,
            createOperationLog: (query) => createSchemaOperationLog({ query }),
          }),
          adminRole: await readSessionRole(adminPool),
          runtimeRole: await readSessionRole(pool),
          refreshRuntimeRegistry,
        }),
      }
    }

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
        schemaAdminEnabled: adminPool !== null,
        exposureImportedAt: exposureState.importedAt,
      },
      "Server listening",
    )

    installShutdownHandlers([
      {
        close: async () => {
          await app.close()
          await pool.close()
          if (adminPool) {
            await adminPool.close()
          }
        },
      },
    ])

    started = { app, pool, adminPool, admin }
    return started
  } catch (error: unknown) {
    // If startup fails after creating the pools, close them before
    // propagating so we do not leak connections.
    try {
      await pool.close()
    } catch {
      // Ignore secondary close errors; original error is what matters.
    }
    if (adminPool) {
      try {
        await adminPool.close()
      } catch {
        // Ignore secondary close errors; original error is what matters.
      }
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

async function assertSchemaAdminRoleSafety(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await checkSchemaAdminRoleSafety(client)
  } finally {
    client.release()
  }
}

// Migration 0005/0006 cannot grant history or registry access to a role
// that does not exist yet, so the operator grants it out of band; probe here
// and fail startup with a clear message rather than letting the first
// operation die.
async function assertSchemaAdminHistoryWriteAccess(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await checkSchemaOperationLogWriteAccess(client)
  } finally {
    client.release()
  }
}

async function assertSchemaAdminExposureAccess(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await checkExposureRegistryWriteAccess(client)
  } finally {
    client.release()
  }
}

async function readSessionRole(pool: Pool): Promise<string> {
  const result = await pool.query<{ role: string }>(
    "SELECT current_user AS role",
  )
  const row = result.rows[0]
  if (row === undefined || row.role.length === 0) {
    throw new AppError(
      "DATABASE_UNAVAILABLE",
      "Could not determine database session role",
      503,
    )
  }
  return row.role
}

// URL-text comparison happens in parseConfig; this is the second layer that
// catches host aliases and role mappings only the live sessions reveal.
async function assertSchemaAdminLaneDistinctness(
  runtimePool: Pool,
  adminPool: Pool,
): Promise<void> {
  const runtimeClient = await runtimePool.connect()
  try {
    const adminClient = await adminPool.connect()
    try {
      await assertSchemaAdminSessionDistinct(runtimeClient, adminClient)
    } finally {
      adminClient.release()
    }
  } finally {
    runtimeClient.release()
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
