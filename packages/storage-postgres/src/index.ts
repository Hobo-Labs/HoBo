export {
	CheckpointLogKind,
	type CheckpointLogRecord,
	CheckpointLogRecordSchema,
	type MigrationRecord,
	MigrationRecordSchema,
	type PostgresStoreConfigRecord,
	PostgresStoreConfigRecordSchema,
	StoragePostgresErrorCode,
	type SubscriptionLeaseRecord,
	SubscriptionLeaseRecordSchema,
} from "./_generated/storage_postgres_pb.js";
export {
	POSTGRES_STORE_DEFAULTS,
	type PostgresStoreConfig,
	type PostgresStoreConfigInput,
	parsePostgresStoreConfig,
	postgresStoreConfigFromEnv,
} from "./config.js";
export {
	isRetryableTransactionError,
	remediationFor,
	StoragePostgresError,
	type StoragePostgresFailure,
	storagePostgresErrorCode,
	translatePgError,
} from "./errors.js";
export {
	notifyChannel,
	parseSchemaName,
	quoteSchema,
	type SchemaName,
} from "./identifiers.js";
export { eventIdFor } from "./ids.js";
export {
	type MigrateOptions,
	type MigrationReport,
	migrateSchema,
	serverMajorVersion,
} from "./migrate.js";
export {
	MIGRATIONS,
	type Migration,
	migrationChecksum,
	SCHEMA_VERSION,
} from "./migrations/index.js";
export {
	createPgPool,
	type PgClientLike,
	type PgListenerLike,
	type PgParam,
	type PgPoolLike,
	type PgRow,
} from "./pg.js";
export {
	createPostgresEventStore,
	type PostgresEventStore,
	type PostgresEventStoreOptions,
	type StoreHealth,
} from "./store.js";
export type { CheckpointLogEntry } from "./subscriptions.js";
export {
	STORAGE_POSTGRES_METRICS,
	type StoreMetricAttributes,
	type StoreMetricPoint,
	type StoreTelemetrySink,
} from "./telemetry.js";

// public-contract: the package identity consumers and tooling assert.
export const HOBO_STORAGE_POSTGRES_PACKAGE = "@hobo/storage-postgres";
