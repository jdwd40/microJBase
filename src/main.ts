// Composition root for microJBase v0.1.
//
// PR-01 scope: a minimal Fastify server only. Auth, data, and database
// modules are intentionally not wired here yet; they arrive in later waves
// and this file is the only place that will instantiate and wire them
// (see ARCHITECTURE.md dependency rules).

import { pathToFileURL } from "node:url"

import Fastify, { type FastifyInstance } from "fastify"

import { healthStatus } from "./shared/health.js"

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true })

  app.get("/health", async () => ({
    data: { status: healthStatus },
    error: null,
  }))

  return app
}

export async function start(): Promise<FastifyInstance> {
  const host = process.env.HOST ?? "127.0.0.1"
  const port = Number(process.env.PORT ?? 3000)
  const app = buildServer()
  await app.listen({ host, port })
  return app
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  start().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
