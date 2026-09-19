import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  gracefulClose,
  installShutdownHandlers,
  type Closeable,
} from "../../../src/core/lifecycle.js"

class FakeCloseable implements Closeable {
  closed = false
  close = async (): Promise<void> => {
    this.closed = true
  }
}

class FailingCloseable implements Closeable {
  close = async (): Promise<void> => {
    throw new Error("close failed")
  }
}

class SlowCloseable implements Closeable {
  close = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe("gracefulClose", () => {
  it("closes all closeables", async () => {
    const a = new FakeCloseable()
    const b = new FakeCloseable()

    await gracefulClose([a, b])

    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
  })

  it("rejects when a closeable fails", async () => {
    await expect(gracefulClose([new FailingCloseable()])).rejects.toThrow(
      "close failed",
    )
  })

  it("rejects when close takes too long", async () => {
    await expect(gracefulClose([new SlowCloseable()], 10)).rejects.toThrow(
      "Graceful close timed out after 10ms",
    )
  })
})

describe("installShutdownHandlers", () => {
  let uninstall: (() => void) | null = null

  beforeEach(() => {
    // Prevent handlers installed during tests from terminating the process.
    process.removeAllListeners("SIGTERM")
    process.removeAllListeners("SIGINT")
  })

  afterEach(() => {
    uninstall?.()
    uninstall = null
    process.removeAllListeners("SIGTERM")
    process.removeAllListeners("SIGINT")
  })

  it("installs listeners for default signals", () => {
    uninstall = installShutdownHandlers([])

    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0)
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0)
  })

  it("removes listeners when uninstall is called", () => {
    uninstall = installShutdownHandlers([])
    uninstall()

    expect(process.listenerCount("SIGTERM")).toBe(0)
    expect(process.listenerCount("SIGINT")).toBe(0)
  })
})
