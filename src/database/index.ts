// Public database entry point for microJBase (v0.1 plus the v0.2 schema
// catalogue reader and schema snapshot reader).
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
  MIGRATION_HISTORY_SQL,
  classifySchemaObject,
  createSchemaSnapshot,
  createSchemaSnapshotReader,
  mapMigrationHistory,
  readMigrationHistory,
  readSchemaSnapshot,
  type MigrationHistoryRow,
  type SchemaSnapshotDependencies,
  type SchemaSnapshotExposedTable,
  type SchemaSnapshotInput,
} from "./schema-snapshot.js"
export {
  SCHEMA_ADMIN_MAX_CONNECTIONS,
  assertSchemaAdminSessionDistinct,
  checkSchemaAdminRoleSafety,
  createSchemaAdminPool,
  type SchemaAdminPoolConfig,
  type SchemaAdminRoleSafety,
} from "./schema-admin-pool.js"
export {
  checkSchemaOperationLogWriteAccess,
  computeActorFingerprint,
  computeOperationChecksum,
  createSchemaOperationLog,
  type BeginOperationInput,
  type ListOperationsInput,
  type SchemaOperationBeginOutcome,
  type SchemaOperationLog,
  type SchemaOperationLogDependencies,
  type SchemaOperationRecord,
  type SchemaOperationStatus,
} from "./schema-operation-log.js"
export {
  MIGRATION_LOCK_KEY_FOR_DISTINCTION,
  SCHEMA_DDL_LOCK_KEY,
  compileCreateTable,
  createSchemaDdlExecutor,
  describePlan,
  translateDdlError,
  type CreateTableSpec,
  type DdlColumnDefault,
  type DdlColumnSpec,
  type DdlColumnType,
  type DdlPlan,
  type ExecuteOptions,
  type ExecuteOutcome,
  type SchemaDdlExecutor,
  type SchemaDdlExecutorDependencies,
  type SchemaOperationLogQuery,
} from "./schema-ddl.js"
export {
  type ColumnMetadata,
  type VerifiedTableMetadata,
} from "./table-types.js"
