// Public database entry point for microJBase v0.1.
//
// Exports the pool and transaction helpers. Repository adapters and the
// migration runner live in sibling files and are imported by their callers.

export {
  createPool,
  translatePoolError,
  type Pool,
  type PoolConfig,
  type PoolErrorContext,
} from "./pool.js"
export {
  createTransactionRunner,
  translateTransactionError,
  type TransactionContext,
  type TransactionOptions,
  type TransactionRunner,
} from "./transaction.js"
export {
  checkRuntimeRoleSafety,
  checkTableOwnershipAndRls,
  checkRuntimeTablePrivileges,
  checkApplicablePolicies,
  type RuntimeRoleSafety,
  type TableOwnershipCheck,
  type TablePrivilegeCheck,
  type PolicyCheck,
  type RuntimeTableSafety,
} from "./role-safety.js"
