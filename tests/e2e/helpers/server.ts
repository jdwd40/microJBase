// Compiled-server process helpers for the E2E acceptance suite.
//
// Every acceptance test exercises the real compiled server (node dist/main.js)
// over real TCP. A fresh process per test file also gives a fresh in-memory
// auth rate limiter, so the suite is immediately repeatable with no waits.

import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"

import {
  E2E_HOST,
  E2E_TABLES,
  REPO_ROOT,
  adminMaintenanceUrl,
  assertBuildFresh,
  runtimeDatabaseUrl,
} from "./config.js"

function postgresPort(): number {
  const port = new URL(adminMaintenanceUrl()).port
  return port === "" ? 5432 : Number(port)
}

export interface RunningServer {
  process: ChildProcess
  port: number
  baseUrl: string
  /** All stdout/stderr output produced so far (for secret-leak assertions). */
  output(): string
  /** SIGTERM, await clean exit; SIGKILL and throw only on timeout. */
  stop(): Promise<void>
}

/** Allocate a real numeric port by binding a temporary socket to port 0. */
export async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, E2E_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() =>
          reject(new Error("could not determine an ephemeral port")),
        )
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve(port)
        }
      })
    })
  })
}

export interface ServerOptions {
  sessionTtlSeconds?: number
  maxBodyBytes?: number
  logLevel?: string
}

/** Spawn the compiled server against the provisioned E2E database. */
export async function spawnServer(
  options: ServerOptions = {},
): Promise<RunningServer> {
  assertBuildFresh()

  const port = await allocatePort()
  const chunks: Buffer[] = []
  const child = spawn("node", ["dist/main.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: runtimeDatabaseUrl(postgresPort()),
      HOST: E2E_HOST,
      PORT: String(port),
      LOG_LEVEL: options.logLevel ?? "info",
      MICROJBASE_TABLES: E2E_TABLES,
      TRUST_PROXY: "false",
      ...(options.sessionTtlSeconds !== undefined
        ? { SESSION_TTL_SECONDS: String(options.sessionTtlSeconds) }
        : {}),
      ...(options.maxBodyBytes !== undefined
        ? { MAX_BODY_BYTES: String(options.maxBodyBytes) }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk))

  const output = (): string => Buffer.concat(chunks).toString("utf8")

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(
          new Error("server did not exit within 15s of SIGTERM\n" + output()),
        )
      }, 15_000)
      child.once("exit", () => {
        clearTimeout(killTimer)
        resolve()
      })
      child.kill("SIGTERM")
    })
  }

  return {
    process: child,
    port,
    baseUrl: `http://${E2E_HOST}:${port}`,
    output,
    stop,
  }
}

const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 100

/** Poll /health until the server and database are ready. */
export async function waitForHealth(server: RunningServer): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${server.baseUrl}/health`)
      if (response.status === 200) {
        const body = (await response.json()) as {
          data?: { status?: string; database?: string }
        }
        if (body.data?.status === "ok" && body.data?.database === "ok") {
          return
        }
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  throw new Error(
    `server at ${server.baseUrl} did not become ready: ${String(lastError)}\n` +
      server.output(),
  )
}

/** Provision + spawn + wait, the standard per-test-file entry point. */
export async function startE2EServer(
  options: ServerOptions = {},
): Promise<RunningServer> {
  const server = await spawnServer(options)
  try {
    await waitForHealth(server)
  } catch (error) {
    await server.stop().catch(() => undefined)
    throw error
  }
  return server
}
