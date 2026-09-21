// Standard per-test-file lifecycle for the E2E acceptance suite.
//
// Each test file gets: a freshly provisioned database (real migrations, real
// grants), a freshly spawned compiled server (fresh in-memory rate limiter,
// so the suite is immediately repeatable), and guaranteed cleanup.

import { dropDatabase, provisionDatabase } from "./database.js"
import { createApi, nonce, type ApiClient } from "./http.js"
import {
  startE2EServer,
  type RunningServer,
  type ServerOptions,
} from "./server.js"

export interface E2EContext {
  api: ApiClient
  server: RunningServer
  /** Unique per run; suffix emails and other user-supplied data with it. */
  run: string
}

export async function startE2EFile(
  options: ServerOptions = {},
): Promise<E2EContext> {
  const run = nonce()
  await provisionDatabase()
  const server = await startE2EServer(options)
  return { api: createApi(server.baseUrl), server, run }
}

export async function stopE2EFile(context: E2EContext): Promise<void> {
  try {
    await context.server.stop()
  } finally {
    await dropDatabase().catch(() => undefined)
  }
}

export { nonce }
