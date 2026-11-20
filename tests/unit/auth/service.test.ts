import { createHash } from "node:crypto"
import { setImmediate } from "node:timers/promises"
import argon2 from "argon2"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { AuthRepository } from "../../../src/contracts/index.js"
import {
  AuthError,
  createAuthService,
  type AuthServiceOptions,
  hashPassword,
  verifyPassword,
} from "../../../src/auth/index.js"
import { DUMMY_PASSWORD_HASH } from "../../../src/auth/password.js"

const now = new Date("2026-09-19T12:00:00.000Z")
const expiresAt = new Date("2026-09-19T13:00:00.000Z")
const password = "correct horse battery staple"
const bytes = Buffer.alloc(32, 7)
const token = bytes.toString("base64url")
const tokenHash = createHash("sha256").update(bytes).digest()
const user = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: "alice@example.com",
  createdAt: now,
}
const session = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  userId: user.id,
  tokenHash,
  expiresAt,
  createdAt: now,
  revokedAt: null,
}
let passwordHash: string
beforeAll(async () => {
  passwordHash = await hashPassword(password)
})

function setup(
  options: AuthServiceOptions = {
    sessionTtlSeconds: 3600,
    now: () => now,
    randomBytes: () => bytes,
  },
) {
  const repository = {
    createUserAndSession: vi.fn<AuthRepository["createUserAndSession"]>(),
    findByEmail: vi.fn<AuthRepository["findByEmail"]>(),
    createSession: vi.fn<AuthRepository["createSession"]>(),
    findActiveUserByTokenHash:
      vi.fn<AuthRepository["findActiveUserByTokenHash"]>(),
    revokeByTokenHash: vi.fn<AuthRepository["revokeByTokenHash"]>(),
  }
  const service = createAuthService(repository, options)
  return { repository, service }
}

async function expectPublicFailure(
  result: Promise<unknown>,
  code: string,
  status: number,
  message: string,
  ...secrets: string[]
) {
  const error: unknown = await result.then(
    () => {
      throw new Error("Expected the auth operation to reject")
    },
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(AuthError)
  expect(error).toMatchObject({ code, status, message })
  const failure = error as AuthError
  const serialized = JSON.stringify({
    message: failure.message,
    code: failure.code,
    details: failure.details,
    stack: failure.stack,
  })
  for (const secret of [password, token, passwordHash, ...secrets])
    expect(serialized).not.toContain(secret)
  expect(serialized.toLowerCase()).not.toContain("passwordhash")
}

describe("AuthService", () => {
  it("registers the normalised email with a password hash, token digest and expiry", async () => {
    const { repository, service } = setup()
    repository.createUserAndSession.mockResolvedValue({ user, session })
    const result = await service.register({
      email: "  Alice@Example.COM ",
      password,
    })
    expect(result).toEqual({ user, token, expiresAt })
    expect(repository.createUserAndSession).toHaveBeenCalledExactlyOnceWith({
      email: user.email,
      passwordHash: expect.any(String),
      tokenHash,
      expiresAt,
    })
    const storedHash =
      repository.createUserAndSession.mock.calls[0]![0].passwordHash
    expect(await verifyPassword(storedHash, password)).toBe(true)
    expect(storedHash).not.toContain(password)
  })

  it("returns a redacted conflict when the email is already registered", async () => {
    const { repository, service } = setup()
    repository.createUserAndSession.mockRejectedValue(
      new AuthError("EMAIL_ALREADY_REGISTERED", passwordHash, 409),
    )
    await expectPublicFailure(
      service.register({ email: user.email, password }),
      "EMAIL_ALREADY_REGISTERED",
      409,
      "Email already registered",
    )
    expect(repository.createUserAndSession).toHaveBeenCalledTimes(1)
  })

  it("logs in an existing user with the default seven-day session and only public fields", async () => {
    const { service, repository } = setup({ now: () => now })
    repository.findByEmail.mockResolvedValue({ ...user, passwordHash })
    repository.createSession.mockImplementation(async (input) => ({
      ...session,
      ...input,
    }))
    const result = await service.login({ email: "Alice@Example.COM", password })
    const defaultExpiry = new Date("2026-09-26T12:00:00.000Z")
    expect(result).toEqual({
      user,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: defaultExpiry,
    })
    expect(repository.findByEmail).toHaveBeenCalledExactlyOnceWith(user.email)
    expect(repository.createSession).toHaveBeenCalledExactlyOnceWith({
      userId: user.id,
      tokenHash: createHash("sha256")
        .update(Buffer.from(result.token, "base64url"))
        .digest(),
      expiresAt: defaultExpiry,
    })
  })

  it("returns identical public failures and finishes password verification for an unknown email", async () => {
    const { repository, service } = setup()
    const wrongPassword = "wrong password!!"
    repository.findByEmail
      .mockResolvedValueOnce({ ...user, passwordHash })
      .mockResolvedValueOnce(null)
    const verify = vi.spyOn(argon2, "verify")
    try {
      await expectPublicFailure(
        service.login({ email: user.email, password: wrongPassword }),
        "INVALID_CREDENTIALS",
        401,
        "Invalid email or password",
        wrongPassword,
      )
      expect(verify).toHaveBeenCalledExactlyOnceWith(
        passwordHash,
        wrongPassword,
      )

      let finishVerification!: (valid: boolean) => void
      verify.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishVerification = resolve
          }),
      )
      const unknown = service.login({
        email: "unknown@example.com",
        password: wrongPassword,
      })
      // One event-loop turn drains login's promise work while Argon2 is held open.
      const first = await Promise.race([
        unknown.then(
          () => "resolved",
          () => "rejected",
        ),
        setImmediate("pending"),
      ])
      expect(verify).toHaveBeenNthCalledWith(
        2,
        DUMMY_PASSWORD_HASH,
        wrongPassword,
      )
      expect(first, "unknown-email login returned before Argon2 finished").toBe(
        "pending",
      )
      finishVerification(false)
      await expectPublicFailure(
        unknown,
        "INVALID_CREDENTIALS",
        401,
        "Invalid email or password",
        wrongPassword,
      )
      expect(repository.createSession).not.toHaveBeenCalled()
    } finally {
      verify.mockRestore()
    }
  })

  it("authenticates using the token digest and current time and rejects inactive sessions", async () => {
    const { service, repository } = setup()
    const active = { id: user.id, email: user.email }
    repository.findActiveUserByTokenHash
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(null)
    expect(await service.authenticate(token)).toEqual(active)
    expect(
      repository.findActiveUserByTokenHash,
    ).toHaveBeenCalledExactlyOnceWith(tokenHash, now)
    await expectPublicFailure(
      service.authenticate(token),
      "AUTH_REQUIRED",
      401,
      "Authentication required",
    )
  })

  it.each(["authenticate", "logout"] as const)(
    "%s rejects a malformed token before querying sessions",
    async (operation) => {
      const { service, repository } = setup()
      const malformed = "not-a-valid-token"
      await expectPublicFailure(
        service[operation](malformed),
        "AUTH_REQUIRED",
        401,
        "Authentication required",
        malformed,
      )
      expect(repository.findActiveUserByTokenHash).not.toHaveBeenCalled()
      expect(repository.revokeByTokenHash).not.toHaveBeenCalled()
    },
  )

  it("logout succeeds for a live, already revoked, or unknown token", async () => {
    const { service, repository } = setup()
    const orphan = Buffer.alloc(32, 9)
    repository.revokeByTokenHash
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false)
    for (const raw of [token, token, orphan.toString("base64url")])
      await expect(service.logout(raw)).resolves.toBeUndefined()
    expect(repository.revokeByTokenHash.mock.calls).toEqual([
      [tokenHash, now],
      [tokenHash, now],
      [createHash("sha256").update(orphan).digest(), now],
    ])
  })
})
