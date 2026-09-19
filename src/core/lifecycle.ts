// Lifecycle primitives for microJBase v0.1.
//
// Provides graceful shutdown signal handling and typed closeables.
// Keeps core free of feature-module dependencies.

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

  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true

    const timeout = setTimeout(() => {
      console.error(
        `Shutdown timed out after ${timeoutMs}ms (${signal}); forcing exit`,
      )
      process.exit(1)
    }, timeoutMs)

    try {
      await Promise.all(closeables.map((c) => c.close()))
      clearTimeout(timeout)
      process.exitCode = 0
    } catch (error: unknown) {
      clearTimeout(timeout)
      console.error("Error during graceful shutdown:", error)
      process.exitCode = 1
    }
  }

  for (const signal of signals) {
    process.on(signal, () => {
      handler(signal).catch((error: unknown) => {
        console.error("Unexpected shutdown handler error:", error)
        process.exit(1)
      })
    })
  }

  return () => {
    for (const signal of signals) {
      process.removeAllListeners(signal)
    }
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
