import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import type {
  AuthenticatedUser,
  AuthRepository,
  Session,
  User,
  UserId,
  UserRecord,
} from "../../../src/contracts/index.js"
import {
  AuthError,
  createAuthService,
  hashPassword,
} from "../../../src/auth/index.js"

class FakeAuthRepository implements AuthRepository {
  users = new Map<string, UserRecord>()
  sessions = new Map<string, Session>() // key: tokenHash hex

  async createUserAndSession(input: {
    email: string
    passwordHash: string
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<{ user: User; session: Session }> {
    if (this.users.has(input.email)) {
      throw new AuthError(
        "EMAIL_ALREADY_REGISTERED",
        "Email already registered",
        409,
      )
    }

    const user: UserRecord = {
      id: randomUUID(),
      email: input.email,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      passwordHash: input.passwordHash,
    }
    const session: Session = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: Buffer.from(input.tokenHash),
      expiresAt: input.expiresAt,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      revokedAt: null,
    }

    // Atomic: only persist both after conflict check (rollback = never insert).
    this.users.set(user.email, user)
    this.sessions.set(session.tokenHash.toString("hex"), session)
    return {
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
      session,
    }
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.users.get(email) ?? null
  }

  async createSession(input: {
    userId: UserId
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: Buffer.from(input.tokenHash),
      expiresAt: input.expiresAt,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      revokedAt: null,
    }
    this.sessions.set(session.tokenHash.toString("hex"), session)
    return session
  }

  async findActiveUserByTokenHash(
    tokenHash: Buffer,
    now: Date,
  ): Promise<AuthenticatedUser | null> {
    const session = this.sessions.get(tokenHash.toString("hex"))
    if (!session) return null
    if (session.revokedAt !== null) return null
    if (!(session.expiresAt > now)) return null
    const user = [...this.users.values()].find((u) => u.id === session.userId)
    if (!user) return null
    return { id: user.id, email: user.email }
  }

  async revokeByTokenHash(
    tokenHash: Buffer,
    revokedAt: Date,
  ): Promise<boolean> {
    const key = tokenHash.toString("hex")
    const session = this.sessions.get(key)
    if (!session) return false
    if (session.revokedAt !== null) return false
    session.revokedAt = revokedAt
    return true
  }
}

function assertNoSecrets(error: AuthError, ...secrets: string[]): void {
  const blob = JSON.stringify({
    message: error.message,
    code: error.code,
    details: error.details,
    stack: error.stack,
  })
  for (const secret of secrets) {
    expect(blob).not.toContain(secret)
  }
  expect(blob.toLowerCase()).not.toContain("passwordhash")
}

describe("AuthService", () => {
  const password = "correct horse battery staple"
  const fixedNow = new Date("2026-09-19T12:00:00.000Z")

  function build(repo = new FakeAuthRepository()) {
    let counter = 0
    const service = createAuthService(repo, {
      sessionTtlSeconds: 3600,
      now: () => fixedNow,
      randomBytes: (size) => {
        const buf = Buffer.alloc(size)
        buf[0] = counter
        counter += 1
        for (let i = 1; i < size; i += 1) buf[i] = (i + counter) % 256
        return buf
      },
    })
    return { service, repo }
  }

  it("register happy path returns user, raw token, and expiry", async () => {
    const { service, repo } = build()
    const result = await service.register({
      email: "  Alice@Example.COM ",
      password,
    })
    expect(result.user.email).toBe("alice@example.com")
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.expiresAt).toEqual(new Date("2026-09-19T13:00:00.000Z"))
    expect(repo.users.size).toBe(1)
    expect(repo.sessions.size).toBe(1)
    const stored = [...repo.users.values()][0]!
    expect(stored.passwordHash).not.toContain(password)
  })

  it("register duplicate email → EMAIL_ALREADY_REGISTERED", async () => {
    const { service } = build()
    await service.register({ email: "bob@example.com", password })
    try {
      await service.register({ email: "BOB@example.com", password })
      expect.fail("expected duplicate to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError)
      const authError = error as AuthError
      expect(authError.code).toBe("EMAIL_ALREADY_REGISTERED")
      expect(authError.status).toBe(409)
      assertNoSecrets(authError, password)
    }
  })

  it("login succeeds with correct credentials", async () => {
    const { service } = build()
    await service.register({ email: "carol@example.com", password })
    const result = await service.login({
      email: "Carol@example.com",
      password,
    })
    expect(result.user.email).toBe("carol@example.com")
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("login wrong password and unknown email share INVALID_CREDENTIALS message", async () => {
    const { service } = build()
    await service.register({ email: "dave@example.com", password })

    let wrongPasswordMessage = ""
    try {
      await service.login({
        email: "dave@example.com",
        password: "wrong password!!",
      })
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("INVALID_CREDENTIALS")
      expect(authError.status).toBe(401)
      wrongPasswordMessage = authError.message
      assertNoSecrets(authError, password, "wrong password!!")
    }

    try {
      await service.login({
        email: "nobody@example.com",
        password: "whatever-long-enough",
      })
      expect.fail("expected unknown email to throw")
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("INVALID_CREDENTIALS")
      expect(authError.message).toBe(wrongPasswordMessage)
      expect(authError.message).toBe("Invalid email or password")
      assertNoSecrets(authError, "whatever-long-enough")
    }
  })

  it("authenticate success, expired session, and revoked session", async () => {
    const repo = new FakeAuthRepository()
    let now = fixedNow
    const service = createAuthService(repo, {
      sessionTtlSeconds: 60,
      now: () => now,
    })

    const registered = await service.register({
      email: "erin@example.com",
      password,
    })
    const user = await service.authenticate(registered.token)
    expect(user.email).toBe("erin@example.com")

    now = new Date(fixedNow.getTime() + 120_000)
    try {
      await service.authenticate(registered.token)
      expect.fail("expected expired session to throw")
    } catch (error) {
      expect((error as AuthError).code).toBe("AUTH_REQUIRED")
    }

    now = fixedNow
    const again = await service.login({ email: "erin@example.com", password })
    await service.logout(again.token)
    try {
      await service.authenticate(again.token)
      expect.fail("expected revoked session to throw")
    } catch (error) {
      expect((error as AuthError).code).toBe("AUTH_REQUIRED")
      assertNoSecrets(error as AuthError, again.token, password)
    }
  })

  it("authenticate rejects malformed tokens with AUTH_REQUIRED", async () => {
    const { service } = build()
    try {
      await service.authenticate("not-valid")
      expect.fail("expected malformed token to throw")
    } catch (error) {
      const authError = error as AuthError
      expect(authError.code).toBe("AUTH_REQUIRED")
      expect(authError.message).toBe("Authentication required")
    }
  })

  it("logout is idempotent for valid tokens and AUTH_REQUIRED for malformed", async () => {
    const { service } = build()
    const registered = await service.register({
      email: "frank@example.com",
      password,
    })

    await service.logout(registered.token)
    await service.logout(registered.token) // idempotent

    // Valid shape but unknown session — still void
    const orphan = Buffer.alloc(32, 9).toString("base64url")
    await service.logout(orphan)

    try {
      await service.logout("bad")
      expect.fail("expected malformed logout to throw")
    } catch (error) {
      expect((error as AuthError).code).toBe("AUTH_REQUIRED")
    }
  })

  it("errors never include password, raw token, or passwordHash", async () => {
    const { service, repo } = build()
    const result = await service.register({
      email: "grace@example.com",
      password,
    })
    const storedHash = [...repo.users.values()][0]!.passwordHash

    const cases: Array<() => Promise<unknown>> = [
      () => service.register({ email: "grace@example.com", password }),
      () =>
        service.login({
          email: "grace@example.com",
          password: "not-the-password-value",
        }),
      () => service.authenticate("totally-invalid-token"),
      () => service.logout("x"),
    ]

    for (const run of cases) {
      try {
        await run()
      } catch (error) {
        expect(error).toBeInstanceOf(AuthError)
        assertNoSecrets(
          error as AuthError,
          password,
          result.token,
          storedHash,
          "not-the-password-value",
        )
      }
    }
  })

  it("createUserAndSession conflict leaves no partial user when fake rolls back", async () => {
    const repo = new FakeAuthRepository()
    const service = createAuthService(repo, { now: () => fixedNow })
    await service.register({ email: "hank@example.com", password })
    const beforeUsers = repo.users.size
    const beforeSessions = repo.sessions.size
    await expect(
      service.register({ email: "hank@example.com", password }),
    ).rejects.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" })
    expect(repo.users.size).toBe(beforeUsers)
    expect(repo.sessions.size).toBe(beforeSessions)
  })

  it("pre-seeded user can log in via fake repository", async () => {
    const repo = new FakeAuthRepository()
    const passwordHash = await hashPassword(password)
    repo.users.set("ivy@example.com", {
      id: randomUUID(),
      email: "ivy@example.com",
      createdAt: fixedNow,
      passwordHash,
    })
    const service = createAuthService(repo, { now: () => fixedNow })
    const result = await service.login({
      email: "ivy@example.com",
      password,
    })
    expect(result.user.email).toBe("ivy@example.com")
  })
})
