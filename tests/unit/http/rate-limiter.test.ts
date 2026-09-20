import { describe, expect, it } from "vitest"

import { InMemoryRateLimiter } from "../../../src/http/rate-limiter.js"

describe("InMemoryRateLimiter", () => {
  it("allows the first attempt", () => {
    const limiter = new InMemoryRateLimiter()
    const result = limiter.check("ip:1")
    expect(result.allowed).toBe(true)
    expect(result.retryAfterSeconds).toBe(0)
    expect(result.state.attempts).toBe(1)
  })

  it("allows attempts up to the configured threshold", () => {
    const limiter = new InMemoryRateLimiter({ attemptsPerWindow: 3 })
    expect(limiter.check("ip:1").allowed).toBe(true)
    expect(limiter.check("ip:1").allowed).toBe(true)
    expect(limiter.check("ip:1").allowed).toBe(true)
  })

  it("blocks the attempt beyond the threshold", () => {
    const limiter = new InMemoryRateLimiter({ attemptsPerWindow: 2 })
    limiter.check("ip:1")
    limiter.check("ip:1")
    const blocked = limiter.check("ip:1")
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    expect(blocked.state.attempts).toBe(2)
  })

  it("resets the counter after the window expires", () => {
    let now = 0
    const limiter = new InMemoryRateLimiter({
      attemptsPerWindow: 1,
      windowMs: 60_000,
      nowMs: () => now,
    })

    limiter.check("ip:1")
    expect(limiter.check("ip:1").allowed).toBe(false)

    now = 60_001
    const reset = limiter.check("ip:1")
    expect(reset.allowed).toBe(true)
    expect(reset.state.attempts).toBe(1)
  })

  it("tracks register and login separately for the same IP", () => {
    const limiter = new InMemoryRateLimiter({ attemptsPerWindow: 1 })
    expect(limiter.check("register:ip").allowed).toBe(true)
    expect(limiter.check("login:ip").allowed).toBe(true)
    expect(limiter.check("register:ip").allowed).toBe(false)
    expect(limiter.check("login:ip").allowed).toBe(false)
  })

  it("evicts the oldest entry when over the bounded max", () => {
    let now = 0
    const limiter = new InMemoryRateLimiter({
      attemptsPerWindow: 10,
      maxEntries: 3,
      nowMs: () => now,
    })

    limiter.check("ip:1")
    now += 1000
    limiter.check("ip:2")
    now += 1000
    limiter.check("ip:3")
    // ip:1 is the oldest; adding ip:4 should evict it.
    now += 1000
    limiter.check("ip:4")

    // ip:1 should have been evicted and can register a new entry.
    const evicted = limiter.check("ip:1")
    expect(evicted.allowed).toBe(true)
    expect(evicted.state.attempts).toBe(1)
  })

  it("evicts expired entries before the oldest-entry eviction", () => {
    let now = 0
    const limiter = new InMemoryRateLimiter({
      attemptsPerWindow: 10,
      windowMs: 60_000,
      maxEntries: 2,
      nowMs: () => now,
    })

    limiter.check("ip:1")
    now = 30_000
    limiter.check("ip:2")
    now = 61_000
    // ip:1 has expired; ip:3 can be added without evicting ip:2.
    limiter.check("ip:3")

    // ip:2 should still be present and counted (it had one prior attempt).
    const result = limiter.check("ip:2")
    expect(result.allowed).toBe(true)
    expect(result.state.attempts).toBe(2)
  })
})
