/**
 * @hobo/data-mongodb — the MongoDB engine for the engine-neutral data
 * contract (ADR-0177): the `data.mongodb/v1` profile and the
 * `@hobo/data-core` SPI over an injected executor, with no driver dependency
 * at runtime.
 */
export {
	type DecodedDocument,
	type DocumentIdentity,
	datasetValidator,
	decodeDocument,
	decodeValue,
	documentId,
	encodeDocument,
	encodeValue,
	identityOf,
	MONGO_OPEN_FIELD,
} from "./codec.js";
export {
	DECIMAL128_MAX_DIGITS,
	DECIMAL128_MAX_EXPONENT,
	DECIMAL128_MIN_EXPONENT,
	formatDecimal128,
	fromDecimal128Text,
	toDecimal128Text,
} from "./decimal.js";
export {
	MONGO_ENGINE_ID,
	MONGO_ENGINE_PROFILE,
	MONGO_IMPEDANCE_CODES,
	MONGO_TYPE_MAPPING,
	type MongoDeclarationOptions,
	type MongoImpedanceCode,
	mongoEngineDeclaration,
} from "./declaration.js";
export {
	createMongoEngine,
	MONGO_DEFAULT_SCAN_PAGE,
	MONGO_METADATA_COLLECTION,
	type MongoEngineOptions,
	type MongoEngineSettings,
	parseMongoEngineOptions,
} from "./engine.js";
export {
	isDuplicateKey,
	isMongoDataError,
	MONGO_DATA_ERROR_CODES,
	MONGO_SERVER_CODES,
	MongoCommandError,
	type MongoCommandFailure,
	MongoDataError,
	type MongoDataErrorCode,
	type MongoDataErrorDetail,
	type MongoDataErrorOptions,
	toMongoDataError,
} from "./errors.js";
export type {
	MongoAwaitTransactionsRequest,
	MongoBulkWriteRequest,
	MongoBulkWriteResult,
	MongoChangeBatch,
	MongoChangeEvent,
	MongoChangeHeadRequest,
	MongoChangeReadRequest,
	MongoChangeToken,
	MongoDeleteOperation,
	MongoDeleteRangeOperation,
	MongoEnsureCollectionRequest,
	MongoEnsureCollectionResult,
	MongoExecutor,
	MongoFindRequest,
	MongoFindResult,
	MongoIdRange,
	MongoIdSelector,
	MongoIdSet,
	MongoInsertOperation,
	MongoKeyMatch,
	MongoReplaceOperation,
	MongoSession,
	MongoWriteOperation,
} from "./executor.js";
export {
	binaryOf,
	dateOf,
	doubleText,
	MONGO_BSON_TYPES,
	MONGO_MAX_KEY,
	MONGO_MIN_KEY,
	type MongoBinary,
	type MongoBsonType,
	type MongoDocument,
	type MongoValue,
	mongoBinary,
	mongoDate,
	mongoDecimal,
	mongoDouble,
	mongoLong,
	mongoTypeOf,
	wrappedText,
} from "./extended-json.js";
export {
	createMemoryMongoExecutor,
	type MemoryMongoExecutor,
} from "./memory-executor.js";
export {
	parseAwaitTransactionsRequest,
	parseBulkWriteRequest,
	parseChangeHeadRequest,
	parseChangeReadRequest,
	parseEnsureCollectionRequest,
	parseFindRequest,
} from "./wire.js";

// public-contract: package id consumers assert against.
export const HOBO_DATA_MONGODB_PACKAGE = "@hobo/data-mongodb";
