// Frozen auth contracts for microJBase v0.1 (see CONTRACTS.md).
// Architect-owned: proposed changes require the CONTRACTS.md change process.

export type UserId = string // canonical UUID string
export type SessionId = string // canonical UUID string

export interface User {
  id: UserId
  email: string
  createdAt: Date
}

export interface Session {
  id: SessionId
  userId: UserId
  tokenHash: Buffer
  expiresAt: Date
  createdAt: Date
  revokedAt: Date | null
}

export interface AuthenticatedUser {
  id: UserId
  email: string
}

// Password hashes are repository-only data and never appear on the public
// `User` type.
export interface UserRecord extends User {
  passwordHash: string
}

export interface AuthRepository {
  createUserAndSession(input: {
    email: string
    passwordHash: string
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<{ user: User; session: Session }>

  findByEmail(email: string): Promise<UserRecord | null>

  createSession(input: {
    userId: UserId
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<Session>

  findActiveUserByTokenHash(
    tokenHash: Buffer,
    now: Date,
  ): Promise<AuthenticatedUser | null>

  revokeByTokenHash(tokenHash: Buffer, revokedAt: Date): Promise<boolean>
}

export interface AuthResult {
  user: User
  token: string
  expiresAt: Date
}

export interface AuthService {
  register(input: { email: string; password: string }): Promise<AuthResult>
  login(input: { email: string; password: string }): Promise<AuthResult>
  authenticate(rawToken: string): Promise<AuthenticatedUser>
  logout(rawToken: string): Promise<void>
}
