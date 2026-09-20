// Bounded in-memory fixed-window rate limiter for auth endpoints.
//
// - keyed by trusted client IP + endpoint;
// - 10 attempts per window per key by default;
// - 60-second window by default;
// - bounded number of entries with oldest-expiry eviction;
// - no background timer retaining unbounded state.
//
// The implementation is intentionally small and explicit; it is not a generic
// rate-limiting framework and is not distributed.

export interface RateLimiterOptions {
  attemptsPerWindow?: number
  windowMs?: number
  maxEntries?: number
  nowMs?: () => number
}

export interface RateLimitState {
  attempts: number
  windowStart: number
  resetAt: number
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
  state: RateLimitState
}

interface Entry {
  attempts: number
  windowStart: number
  resetAt: number
}

export class InMemoryRateLimiter {
  private readonly attemptsPerWindow: number
  private readonly windowMs: number
  private readonly maxEntries: number
  private readonly nowMs: () => number
  private readonly state: Map<string, Entry>

  constructor(options: RateLimiterOptions = {}) {
    this.attemptsPerWindow = options.attemptsPerWindow ?? 10
    this.windowMs = options.windowMs ?? 60_000
    this.maxEntries = options.maxEntries ?? 10_000
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.state = new Map()
  }

  /**
   * Records one attempt for the key and returns whether it is allowed.
   * Evicts expired entries first, then the oldest entry if still over bounds.
   */
  check(key: string): RateLimitResult {
    const now = this.nowMs()
    this.evictExpired(now)

    const existing = this.state.get(key)
    if (existing === undefined) {
      const resetAt = now + this.windowMs
      const entry: Entry = { attempts: 1, windowStart: now, resetAt }
      this.insert(key, entry)
      return { allowed: true, retryAfterSeconds: 0, state: { ...entry } }
    }

    if (now >= existing.resetAt) {
      // Window has rolled over; reset the counter.
      const resetAt = now + this.windowMs
      const entry: Entry = { attempts: 1, windowStart: now, resetAt }
      this.state.set(key, entry)
      return { allowed: true, retryAfterSeconds: 0, state: { ...entry } }
    }

    if (existing.attempts >= this.attemptsPerWindow) {
      const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000)
      return {
        allowed: false,
        retryAfterSeconds,
        state: { ...existing },
      }
    }

    existing.attempts += 1
    return {
      allowed: true,
      retryAfterSeconds: 0,
      state: { ...existing },
    }
  }

  private insert(key: string, entry: Entry): void {
    if (this.state.size >= this.maxEntries && !this.state.has(key)) {
      this.evictOldest()
    }
    this.state.set(key, entry)
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.state) {
      if (now >= entry.resetAt) {
        this.state.delete(key)
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null
    let oldestResetAt = Number.POSITIVE_INFINITY

    for (const [key, entry] of this.state) {
      if (entry.resetAt < oldestResetAt) {
        oldestResetAt = entry.resetAt
        oldestKey = key
      }
    }

    if (oldestKey !== null) {
      this.state.delete(oldestKey)
    }
  }
}
