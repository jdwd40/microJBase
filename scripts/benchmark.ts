// Reproducible footprint and load benchmark for microJBase v0.1.
//
// Measures real behaviour of the compiled application against a dedicated,
// freshly migrated benchmark database — never the integration or E2E
// databases. Results are printed as JSON plus a human summary so they can be
// pasted into docs/benchmarks.md as release evidence.
//
// Prerequisites:
//   - BENCHMARK_ADMIN_DATABASE_URL: privileged URL for a maintenance database
//     (same shape as E2E_ADMIN_DATABASE_URL), used to create/drop the
//     dedicated benchmark database and runtime role.
//   - `npm ci` and `npm run build` completed (the compiled server is the
//     measurement target).
//
// Usage: BENCHMARK_ADMIN_DATABASE_URL=... npx tsx scripts/benchmark.ts

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { cpus, release as osRelease, totalmem } from "node:os"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)

const BENCH_DATABASE_NAME = "microjbase_benchmark"
const BENCH_RUNTIME_ROLE = "microjbase_benchmark_runtime"
const BENCH_RUNTIME_PASSWORD = "microjbase_benchmark_runtime_password"
const BENCH_TABLES = "todos=public.todos"

const STARTUP_RUNS = 5
const HEALTH_TIMEOUT_MS = 15_000
const HEALTH_POLL_MS = 10
const IDLE_WARMUP_MS = 2_000
const WORKLOAD_CONCURRENCY = 10
const WORKLOAD_REQUESTS = 1_000
const REQUEST_TIMEOUT_MS = 5_000

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} environment variable is required`)
  }
  return value
}

function adminMaintenanceUrl(): string {
  return requireEnv("BENCHMARK_ADMIN_DATABASE_URL")
}

function adminBenchmarkUrl(): string {
  const url = new URL(adminMaintenanceUrl())
  url.pathname = `/${BENCH_DATABASE_NAME}`
  return url.toString()
}

async function withAdminClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminMaintenanceUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function provisionDatabase(): Promise<void> {
  const { migrate } = await import("./migrate.js")
  await withAdminClient(async (client) => {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${BENCH_RUNTIME_ROLE}') THEN
          CREATE ROLE ${BENCH_RUNTIME_ROLE} LOGIN;
        END IF;
      END
      $$;
    `)
    await client.query(`
      ALTER ROLE ${BENCH_RUNTIME_ROLE}
        WITH LOGIN NOSUPERUSER NOBYPASSRLS
        PASSWORD '${BENCH_RUNTIME_PASSWORD}';
    `)
    await client.query(
      `DROP DATABASE IF EXISTS ${BENCH_DATABASE_NAME} WITH (FORCE);`,
    )
    await client.query(`CREATE DATABASE ${BENCH_DATABASE_NAME};`)
  })
  await migrate({ databaseUrl: adminBenchmarkUrl() })
  const benchmark = new pg.Client({ connectionString: adminBenchmarkUrl() })
  await benchmark.connect()
  try {
    await benchmark.query(`
      GRANT USAGE ON SCHEMA microjbase TO ${BENCH_RUNTIME_ROLE};
      GRANT SELECT ON microjbase.schema_migrations TO ${BENCH_RUNTIME_ROLE};
      GRANT SELECT, INSERT ON microjbase.users TO ${BENCH_RUNTIME_ROLE};
      GRANT SELECT, INSERT, UPDATE ON microjbase.sessions TO ${BENCH_RUNTIME_ROLE};
      GRANT USAGE ON SCHEMA public TO ${BENCH_RUNTIME_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO ${BENCH_RUNTIME_ROLE};
      GRANT SELECT ON microjbase.exposure_registry TO ${BENCH_RUNTIME_ROLE};
      GRANT SELECT ON microjbase.exposure_registry_state TO ${BENCH_RUNTIME_ROLE};
      GRANT EXECUTE ON FUNCTION microjbase.import_exposure_registry(JSONB) TO ${BENCH_RUNTIME_ROLE};
    `)
  } finally {
    await benchmark.end()
  }
}

async function dropDatabase(): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(
      `DROP DATABASE IF EXISTS ${BENCH_DATABASE_NAME} WITH (FORCE);`,
    )
  })
}

function assertBuildFresh(): void {
  const entry = path.join(REPO_ROOT, "dist", "main.js")
  if (!existsSync(entry)) {
    throw new Error("dist/main.js not found; run `npm run build` first")
  }
  const entryMtime = statSync(entry).mtimeMs
  const stale = findNewerThan(path.join(REPO_ROOT, "src"), entryMtime)
  if (stale !== null) {
    throw new Error(
      `${stale} is newer than dist/main.js; run \`npm run build\` first`,
    )
  }
}

function findNewerThan(dir: string, mtimeMs: number): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findNewerThan(full, mtimeMs)
      if (nested !== null) {
        return nested
      }
    } else if (entry.name.endsWith(".ts") && statSync(full).mtimeMs > mtimeMs) {
      return full
    }
  }
  return null
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("could not determine a free port"))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

function postgresPort(): number {
  const port = new URL(adminMaintenanceUrl()).port
  return port === "" ? 5432 : Number(port)
}

function runtimeDatabaseUrl(): string {
  const url = new URL(adminMaintenanceUrl())
  url.username = BENCH_RUNTIME_ROLE
  url.password = BENCH_RUNTIME_PASSWORD
  url.port = String(postgresPort())
  url.pathname = `/${BENCH_DATABASE_NAME}`
  return url.toString()
}

interface RunningApp {
  process: ChildProcess
  pid: number
  baseUrl: string
  port: number
  /** Captured stdout/stderr for diagnostics. */
  output(): string
}

async function startApp(): Promise<RunningApp> {
  const port = await freePort()
  const chunks: Buffer[] = []
  const child = spawn("node", ["dist/main.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: runtimeDatabaseUrl(),
      HOST: "127.0.0.1",
      PORT: String(port),
      MICROJBASE_TABLES: BENCH_TABLES,
      LOG_LEVEL: "fatal",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (child.pid === undefined) {
    throw new Error("failed to spawn application process")
  }
  // Capture output for diagnostics so pipe backpressure can never stall the
  // child either.
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk))
  return {
    process: child,
    pid: child.pid,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    output: () => Buffer.concat(chunks).toString("utf8"),
  }
}

async function waitForHealth(
  app: RunningApp,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    if (app.process.exitCode !== null) {
      throw new Error(
        `application exited during startup with code ${app.process.exitCode}\n${app.output()}`,
      )
    }
    try {
      const response = await fetch(`${app.baseUrl}/health`)
      if (response.status === 200) {
        return
      }
      lastError = new Error(`health returned ${response.status}`)
    } catch (error: unknown) {
      lastError = error
    }
    await sleep(HEALTH_POLL_MS)
  }
  throw new Error(
    `application did not become healthy within ${timeoutMs}ms: ${String(lastError)}\n${app.output()}`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function stopApp(app: RunningApp): Promise<void> {
  if (app.process.exitCode !== null || app.process.signalCode !== null) {
    return
  }
  const exited = new Promise<number | null>((resolve) => {
    app.process.once("exit", (code) => resolve(code))
  })
  app.process.kill("SIGTERM")
  const exitCode = await Promise.race([
    exited,
    sleep(15_000).then(() => "timeout" as const),
  ])
  if (exitCode === "timeout") {
    app.process.kill("SIGKILL")
    throw new Error("application did not exit within 15s of SIGTERM")
  }
  if (exitCode !== 0) {
    throw new Error(`application exited with code ${exitCode} after SIGTERM`)
  }
}

function rssMiB(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8")
  const match = /^VmRSS:\s+(\d+) kB/m.exec(status)
  if (match === null || match[1] === undefined) {
    throw new Error(`could not read VmRSS for pid ${pid}`)
  }
  return Number(match[1]) / 1024
}

async function measureStartupOnce(): Promise<number> {
  const app = await startApp()
  try {
    const started = Date.now()
    await waitForHealth(app, HEALTH_TIMEOUT_MS)
    return Date.now() - started
  } finally {
    await stopApp(app)
  }
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid] as number
  }
  const a = sorted[mid - 1] as number
  const b = sorted[mid] as number
  return (a + b) / 2
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return sorted[index] as number
}

interface WorkloadResult {
  totalRequests: number
  failures: number
  durationMs: number
  requestsPerSecond: number
  latency: {
    meanMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
  }
}

async function runWorkload(
  baseUrl: string,
  token: string,
): Promise<WorkloadResult> {
  const latencies: number[] = []
  let failures = 0
  const started = Date.now()
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < WORKLOAD_REQUESTS) {
      const index = cursor
      cursor += 1
      const authenticated = index % 10 >= 7
      const url = authenticated
        ? `${baseUrl}/v1/data/todos`
        : `${baseUrl}/health`
      const headers: Record<string, string> = {}
      if (authenticated) {
        headers.authorization = `Bearer ${token}`
      }
      const begin = performance.now()
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        })
        clearTimeout(timeout)
        await response.arrayBuffer()
        if (response.status !== 200) {
          failures += 1
        }
      } catch {
        failures += 1
      }
      latencies.push(performance.now() - begin)
    }
  }

  await Promise.all(
    Array.from({ length: WORKLOAD_CONCURRENCY }, () => worker()),
  )
  const durationMs = Date.now() - started
  latencies.sort((a, b) => a - b)
  const mean =
    latencies.reduce((sum, value) => sum + value, 0) / latencies.length
  return {
    totalRequests: WORKLOAD_REQUESTS,
    failures,
    durationMs,
    requestsPerSecond: (WORKLOAD_REQUESTS / durationMs) * 1000,
    latency: {
      meanMs: mean,
      p50Ms: median(latencies),
      p95Ms: percentile(latencies, 95),
      p99Ms: percentile(latencies, 99),
      maxMs: latencies[latencies.length - 1] as number,
    },
  }
}

async function main(): Promise<void> {
  assertBuildFresh()
  console.log("Provisioning benchmark database...")
  await provisionDatabase()

  const environment = {
    os: `${process.platform} ${process.arch}`,
    osRelease: osRelease(),
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalRamMiB: Math.round(totalmem() / 1024 / 1024),
    node: process.version,
    commit: execGit(["rev-parse", "HEAD"]),
  }

  try {
    console.log(`Measuring startup (${STARTUP_RUNS} runs)...`)
    const startupRuns: number[] = []
    for (let i = 0; i < STARTUP_RUNS; i += 1) {
      startupRuns.push(await measureStartupOnce())
    }
    startupRuns.sort((a, b) => a - b)

    console.log("Measuring idle RSS and workload...")
    const app = await startApp()
    let rssIdleMiB = 0
    let rssAfterWorkloadMiB = 0
    let workload: WorkloadResult | null = null
    try {
      await waitForHealth(app, HEALTH_TIMEOUT_MS)
      await sleep(IDLE_WARMUP_MS)
      rssIdleMiB = rssMiB(app.pid)

      const nonce = Math.random().toString(36).slice(2, 10)
      const register = await fetch(`${app.baseUrl}/v1/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `bench-${nonce}@example.test`,
          password: "correct horse battery staple",
        }),
      })
      if (register.status !== 201) {
        throw new Error(
          `benchmark user registration failed: ${register.status}`,
        )
      }
      const token = (
        (await register.json()) as {
          data: { token: string }
        }
      ).data.token

      for (let i = 0; i < 20; i += 1) {
        const create = await fetch(`${app.baseUrl}/v1/data/todos`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ title: `benchmark todo ${i}` }),
        })
        if (create.status !== 201) {
          throw new Error(`benchmark todo creation failed: ${create.status}`)
        }
      }

      workload = await runWorkload(app.baseUrl, token)
      rssAfterWorkloadMiB = rssMiB(app.pid)
    } finally {
      await stopApp(app)
    }

    const result = {
      environment,
      startup: {
        definition:
          "spawn `node dist/main.js` to first HTTP 200 from GET /health, local poll every 10ms",
        runs: startupRuns,
        runCount: startupRuns.length,
        medianMs: median(startupRuns),
        minMs: startupRuns[0] as number,
        maxMs: startupRuns[startupRuns.length - 1] as number,
      },
      memory: {
        source: "VmRSS from /proc/<pid>/status of the Node application process",
        idleWarmupMs: IDLE_WARMUP_MS,
        idleMiB: rssIdleMiB,
        afterWorkloadMiB: rssAfterWorkloadMiB,
        note: "PostgreSQL memory is a separate OS process and is not included.",
      },
      workload,
    }

    console.log("\n===== BENCHMARK RESULT (JSON) =====")
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await dropDatabase()
  }
}

function execGit(args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], { cwd: REPO_ROOT })
      .toString()
      .trim()
  } catch {
    return "unknown"
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
