export {
	DEFAULT_METADATA_CODEC,
	DEFAULT_PAYLOAD_CODEC,
	DEFAULT_STATE_CODEC,
	decodeJson,
	decodeLegacyJsonText,
	decodeMetadata,
	decodePayload,
	encodeJson,
	encodeLegacyJsonText,
	encodeMetadata,
	encodePayload,
	type PayloadCodec,
	parseCodec,
	UnsupportedCodecError,
} from "./codec.js";
export {
	asBigInt,
	asBytes,
	asNumber,
	asText,
	type SqliteDriver,
	type SqliteRunResult,
	type SqliteStatement,
	type SqliteValue,
} from "./driver.js";
export { createDeterministicId, createUlidGenerator } from "./ids.js";
export {
	type JournalOpenOptions,
	type ParsedEventInput,
	SqliteJournal,
	type StreamHead,
} from "./journal.js";
export {
	assertIntegrity,
	installLegacyV1Fixture,
	MigrationFailureError,
	type MigrationReport,
	migrateToCurrent,
	StreamIntegrityError,
} from "./migrate.js";
export {
	createMemoryNodeSqliteDriver,
	createNodeSqliteDriver,
	type NodeSqliteDriverOptions,
} from "./node-driver.js";
export {
	assertQuorumEventStore,
	assertQuorumEventStoreJournal,
	createQuorumEventStore,
	type QuorumActorClaim,
	type QuorumClaimCheckpoint,
	type QuorumEventStore,
	type QuorumEventStoreIdentity,
	type QuorumEventStoreOptions,
	type QuorumNonExpiringClaims,
	type QuorumSubscriptionClaim,
	quorumEventStoreIdentity,
} from "./quorum-eventstore.js";
export {
	LEGACY_SCHEMA_VERSION,
	LEGACY_V1_SCHEMA_SQL,
	NATIVE_PRAGMAS,
	SCHEMA_V2_SQL,
	SCHEMA_VERSION,
} from "./schema.js";

export const HOBO_STORAGE_SQLITE_PACKAGE = "@hobo/storage-sqlite";
