export { SQLITE_SCHEMA_FIXTURE } from "./conformance-fixture.js";
export {
	type CreateSqliteDataDualPortOptions,
	createSqliteDataDualPort,
	type DataDualEvidence,
	type DataDualRows,
	FencedTenantError,
	type SqliteDataDualPort,
	type SqliteDataDualWrite,
} from "./data-dual-port.js";
export {
	createSchemaPort,
	createSqliteEngine,
	SQLITE_ENGINE_ID,
	SQLITE_ENGINE_PROFILE,
	SQLITE_IMPEDANCE_CODES,
	SQLITE_TYPE_MAPPING,
	type SqliteEngine,
	type SqliteEngineOptions,
	type SqliteSchemaHost,
	type SyncSchemaApplyPort,
} from "./engine.js";
export {
	SQLITE_DATA_ERROR_CODES,
	SqliteDataError,
	type SqliteDataErrorCode,
	type SqliteDataErrorDetail,
	type SqliteDataErrorOptions,
} from "./errors.js";
export {
	type CreateSqliteSchemaApplyPortOptions,
	createSqliteSchemaApplyPort,
	type SqliteSchemaApplyPort,
} from "./schema-apply-port.js";
export {
	type FenceRow,
	quoteIdentifier,
	SqliteDatasetStore,
	type SqliteStoreOptions,
	sqliteNativeType,
} from "./store.js";

// public-contract: package id consumers assert against.
export const HOBO_DATA_SQLITE_PACKAGE = "@hobo/data-sqlite";
