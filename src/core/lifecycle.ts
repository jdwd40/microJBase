// Lifecycle primitives for microJBase v0.1.
//
// Provides graceful shutdown signal handling and typed closeables.
// Keeps core free of feature-module dependencies.

import { redactSecrets } from "./config.js"

export interface Closeable {
  close(): Promise<void>
}

export interface ShutdownOptions {
  signals?: readonly NodeJS.Signals[]
  timeoutMs?: number
}

export function installShutdownHandlers(
  closeables: readonly Closeable[],
  options: ShutdownOptions = {},
): () => void {
  const signals = options.signals ?? ["SIGTERM", "SIGINT"]
  const timeoutMs = options.timeoutMs ?? 10000

  let shuttingDown = false
  const installed = new Map<NodeJS.Signals, () => void>()

  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    const timeout = setTimeout(() => {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "Shutdown timed out; forcing exit",
          signal,
          timeoutMs,
        }),
      )
      process.exit(1)
    }, timeoutMs)

    try {
      await Promise.all(closeables.map((c) => c.close()))
      clearTimeout(timeout)
      process.exitCode = 0
    } catch (error: unknown) {
      clearTimeout(timeout)
      const raw = error instanceof Error ? error.message : String(error)
      const redacted = redactSecrets(raw)
      const safeError =
        typeof redacted === "string" ? redacted : JSON.stringify(redacted)
      console.error(
        JSON.stringify({
          level: "error",
          msg: "Error during graceful shutdown",
          error: safeError.replaceAll("postgres://", "***"),
        }),
      )
      process.exitCode = 1
    }
  }

  for (const signal of signals) {
    const wrapper = (): void => {
      handler(signal).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "Unexpected shutdown handler error",
            error: redactSecrets(
              error instanceof Error ? error.message : String(error),
            ),
          }),
        )
        process.exit(1)
      })
    }
    installed.set(signal, wrapper)
    process.on(signal, wrapper)
  }

  return () => {
    for (const [signal, wrapper] of installed) {
      process.off(signal, wrapper)
    }
    installed.clear()
  }
}

export async function gracefulClose(
  closeables: readonly Closeable[],
  timeoutMs: number = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Graceful close timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    Promise.all(closeables.map((c) => c.close()))
      .then(() => {
        clearTimeout(timeout)
        resolve()
      })
      .catch((error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      })
  })
}
