// Public database entry point for microJBase (v0.1 plus the v0.2 schema
// catalogue reader).
//
// Exports the pool and transaction helpers. Repository adapters and the
// migration runner live in sibling files and are imported by their callers.

export {
  createPool,
  translatePoolError,
  type Pool,
  type PoolConfig,
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
export { createAuthRepository } from "./auth-repository.js"
export {
  createPostgresDataRepository,
  translateDataError,
  type PostgresDataRepositoryDependencies,
} from "./data-repository.js"
export {
  buildTableRegistry,
  buildTableRegistryFromEnv,
  quoteIdentifier,
  quoteTableIdentifier,
  type ExposedTableMapping,
  type TableRegistryConfig,
  type RegistryBuildDependencies,
} from "./table-registry.js"
export {
  createSchemaCatalogueReader,
  readSchemaCatalogue,
  type SchemaCatalogueDependencies,
} from "./schema-catalogue.js"
export {
  type ColumnMetadata,
  type VerifiedTableMetadata,
} from "./table-types.js"
