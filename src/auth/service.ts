// AuthService implementation — domain only; no pg/Fastify.

import { randomBytes as nodeRandomBytes } from "node:crypto"

import type {
  AuthenticatedUser,
  AuthRepository,
  AuthResult,
  AuthService,
} from "../contracts/index.js"

import { normaliseEmail } from "./email.js"
import { AuthError, isAppErrorLike } from "./errors.js"
import {
  hashPassword,
  validatePassword,
  verifyDummyPassword,
  verifyPassword,
} from "./password.js"
import {
  generateSessionToken,
  hashRawToken,
  type RandomBytesFn,
} from "./token.js"

const DEFAULT_SESSION_TTL_SECONDS = 604_800

export interface AuthServiceOptions {
  sessionTtlSeconds?: number
  now?: () => Date
  randomBytes?: RandomBytesFn
}

export class AuthServiceImpl implements AuthService {
  private readonly sessionTtlSeconds: number
  private readonly now: () => Date
  private readonly randomBytes: RandomBytesFn

  constructor(
    private readonly repository: AuthRepository,
    options: AuthServiceOptions = {},
  ) {
    this.sessionTtlSeconds =
      options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
    this.now = options.now ?? (() => new Date())
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
  }

  async register(input: {
    email: string
    password: string
  }): Promise<AuthResult> {
    const email = normaliseEmail(input.email)
    validatePassword(input.password)

    const passwordHash = await hashPassword(input.password)
    const { rawToken, tokenHash } = generateSessionToken(this.randomBytes)
    const now = this.now()
    const expiresAt = new Date(now.getTime() + this.sessionTtlSeconds * 1000)

    let created: Awaited<ReturnType<AuthRepository["createUserAndSession"]>>
    try {
      created = await this.repository.createUserAndSession({
        email,
        passwordHash,
        tokenHash,
        expiresAt,
      })
    } catch (error: unknown) {
      if (isAppErrorLike(error) && error.code === "EMAIL_ALREADY_REGISTERED") {
        throw new AuthError(
          "EMAIL_ALREADY_REGISTERED",
          "Email already registered",
          409,
        )
      }
      throw error
    }

    return {
      user: created.user,
      token: rawToken,
      expiresAt: created.session.expiresAt,
    }
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const email = normaliseEmail(input.email)
    const user = await this.repository.findByEmail(email)

    if (user === null) {
      await verifyDummyPassword(input.password)
      throw new AuthError(
        "INVALID_CREDENTIALS",
        "Invalid email or password",
        401,
      )
    }

    const passwordOk = await verifyPassword(user.passwordHash, input.password)
    if (!passwordOk) {
      throw new AuthError(
        "INVALID_CREDENTIALS",
        "Invalid email or password",
        401,
      )
    }

    const { rawToken, tokenHash } = generateSessionToken(this.randomBytes)
    const now = this.now()
    const expiresAt = new Date(now.getTime() + this.sessionTtlSeconds * 1000)
    const session = await this.repository.createSession({
      userId: user.id,
      tokenHash,
      expiresAt,
    })

    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
      token: rawToken,
      expiresAt: session.expiresAt,
    }
  }

  async authenticate(rawToken: string): Promise<AuthenticatedUser> {
    const tokenHash = hashRawToken(rawToken)
    if (tokenHash === null) {
      throw new AuthError("AUTH_REQUIRED", "Authentication required", 401)
    }

    const user = await this.repository.findActiveUserByTokenHash(
      tokenHash,
      this.now(),
    )
    if (user === null) {
      throw new AuthError("AUTH_REQUIRED", "Authentication required", 401)
    }

    return user
  }

  async logout(rawToken: string): Promise<void> {
    const tokenHash = hashRawToken(rawToken)
    if (tokenHash === null) {
      throw new AuthError("AUTH_REQUIRED", "Authentication required", 401)
    }

    await this.repository.revokeByTokenHash(tokenHash, this.now())
  }
}

export function createAuthService(
  repository: AuthRepository,
  options?: AuthServiceOptions,
): AuthService {
  return new AuthServiceImpl(repository, options ?? {})
}
