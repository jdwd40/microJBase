// Public entry point for the auth domain module.

export {
  decodeAdminTokenDigest,
  hashOperatorToken,
  verifyOperatorToken,
} from "./admin-token.js"
export { AuthError, isAppErrorLike } from "./errors.js"
export { normaliseEmail } from "./email.js"
export {
  ARGON2_MEMORY_COST_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  validatePassword,
  verifyDummyPassword,
  verifyPassword,
} from "./password.js"
export {
  generateSessionToken,
  hashRawToken,
  hashTokenBytes,
  parseRawToken,
  TOKEN_BYTE_LENGTH,
  type RandomBytesFn,
} from "./token.js"
export {
  AuthServiceImpl,
  createAuthService,
  type AuthServiceOptions,
} from "./service.js"
