/**
 * Stable error codes for the MongoDB engine binding.
 *
 * Two classes, for two sides of the executor boundary. An executor reports a
 * refused command as a `MongoCommandError` carrying the server's numeric code
 * and nothing else; the binding turns that into a `MongoDataError` a caller
 * can act on. Contract-level refusals (a fenced write, a refused retire, a
 * differing schema) stay `DataCoreError`s from `@hobo/data-core`, so they mean
 * the same thing on every engine.
 *
 * Neither class ever carries a server message. MongoDB quotes the offending
 * key in a duplicate-key error and the offending document in a validation
 * error, and both are payload.
 */

export const MONGO_DATA_ERROR_CODES = [
	/** The engine options were refused at construction. */
	"MONGODB_INVALID_OPTIONS",
	/** A port was called with an argument outside its contract. */
	"MONGODB_INVALID_REQUEST",
	/** A canonical value falls outside what its declared native type can hold. */
	"MONGODB_VALUE_NOT_REPRESENTABLE",
	/** A stored value has no canonical form; it was written outside the binding. */
	"MONGODB_NON_CANONICAL_VALUE",
	/** The collection's validator refused the document. */
	"MONGODB_DOCUMENT_REJECTED",
	/** The document exceeds the 16 MiB BSON limit. */
	"MONGODB_DOCUMENT_TOO_LARGE",
	/** Multi-document transactions are not available (a standalone server). */
	"MONGODB_TRANSACTIONS_UNAVAILABLE",
	/** One atomic unit outgrew a transaction's size or lifetime. */
	"MONGODB_TRANSACTION_LIMIT",
	/** Change streams are not available (a standalone server). */
	"MONGODB_CAPTURE_UNAVAILABLE",
	/** The position is no longer in the oplog, or is not a resume token. */
	"MONGODB_CAPTURE_POSITION_LOST",
	/** The stream reported an event that is not a record change (drop, rename). */
	"MONGODB_CAPTURE_UNSUPPORTED_EVENT",
	/** Any other refused command; `detail.serverCode` names it. */
	"MONGODB_COMMAND_FAILED",
] as const;

export type MongoDataErrorCode = (typeof MONGO_DATA_ERROR_CODES)[number];

export type MongoDataErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type MongoDataErrorOptions = {
	readonly detail?: MongoDataErrorDetail;
	readonly cause?: unknown;
};

export class MongoDataError extends Error {
	readonly code: MongoDataErrorCode;
	readonly detail: MongoDataErrorDetail;

	constructor(
		code: MongoDataErrorCode,
		message: string,
		options: MongoDataErrorOptions = {},
	) {
		super(message, options.cause === undefined ? {} : { cause: options.cause });
		this.name = "MongoDataError";
		this.code = code;
		this.detail = Object.freeze(options.detail ?? {});
	}
}

export function isMongoDataError(
	value: MongoDataError | Error | null | undefined,
): value is MongoDataError {
	return value instanceof MongoDataError;
}

/** What an executor knows about a refused command: codes, never messages. */
// domain-view: the thrown form of the wire record MongoCommandFailure in data-models/data_mongodb.proto.
export interface MongoCommandFailure {
	/** The server's numeric error code; 0 when the refusal was client-side. */
	readonly code: number;
	/** The server's code name, or the client error class when `code` is 0. */
	readonly codeName: string;
	/** Server error labels, e.g. `TransientTransactionError`. */
	readonly labels?: readonly string[];
}

export type MongoCommandErrorOptions = {
	readonly cause?: unknown;
};

/** Thrown by a `MongoExecutor` when the server (or the driver) refuses. */
export class MongoCommandError extends Error {
	readonly code: number;
	readonly codeName: string;
	readonly labels: readonly string[];

	constructor(
		failure: MongoCommandFailure,
		options: MongoCommandErrorOptions = {},
	) {
		super(
			`MongoDB refused the command (code ${failure.code}${failure.codeName === "" ? "" : ` ${failure.codeName}`})`,
			options.cause === undefined ? {} : { cause: options.cause },
		);
		this.name = "MongoCommandError";
		this.code = failure.code;
		this.codeName = failure.codeName;
		this.labels = Object.freeze([...(failure.labels ?? [])]);
	}
}

/** Server error codes the binding gives a meaning to. */
export const MONGO_SERVER_CODES = Object.freeze({
	illegalOperation: 20,
	namespaceExists: 48,
	documentValidationFailure: 121,
	transactionTooLarge: 257,
	invalidResumeToken: 260,
	operationNotSupportedInTransaction: 263,
	changeStreamFatalError: 280,
	changeStreamHistoryLost: 286,
	transactionExceededLifetimeLimit: 290,
	bsonObjectTooLarge: 10334,
	duplicateKey: 11000,
	changeStreamNeedsReplicaSet: 40573,
});

const CODE_MEANING: ReadonlyMap<number, readonly [MongoDataErrorCode, string]> =
	new Map<number, readonly [MongoDataErrorCode, string]>([
		[
			MONGO_SERVER_CODES.documentValidationFailure,
			[
				"MONGODB_DOCUMENT_REJECTED",
				"the collection validator refused the document",
			],
		],
		[
			MONGO_SERVER_CODES.bsonObjectTooLarge,
			[
				"MONGODB_DOCUMENT_TOO_LARGE",
				"the document exceeds the 16 MiB BSON limit",
			],
		],
		[
			MONGO_SERVER_CODES.illegalOperation,
			[
				"MONGODB_TRANSACTIONS_UNAVAILABLE",
				"multi-document transactions need a replica set or a sharded cluster",
			],
		],
		[
			MONGO_SERVER_CODES.operationNotSupportedInTransaction,
			[
				"MONGODB_TRANSACTIONS_UNAVAILABLE",
				"the server cannot run this operation inside a transaction",
			],
		],
		[
			MONGO_SERVER_CODES.transactionTooLarge,
			[
				"MONGODB_TRANSACTION_LIMIT",
				"the atomic unit is larger than one transaction may be",
			],
		],
		[
			MONGO_SERVER_CODES.transactionExceededLifetimeLimit,
			[
				"MONGODB_TRANSACTION_LIMIT",
				"the atomic unit outlived the transaction lifetime limit",
			],
		],
		[
			MONGO_SERVER_CODES.changeStreamNeedsReplicaSet,
			[
				"MONGODB_CAPTURE_UNAVAILABLE",
				"change streams need a replica set or a sharded cluster",
			],
		],
		[
			MONGO_SERVER_CODES.changeStreamHistoryLost,
			[
				"MONGODB_CAPTURE_POSITION_LOST",
				"the position has fallen out of the oplog window",
			],
		],
		[
			MONGO_SERVER_CODES.changeStreamFatalError,
			[
				"MONGODB_CAPTURE_POSITION_LOST",
				"the change stream cannot continue from this position",
			],
		],
		[
			MONGO_SERVER_CODES.invalidResumeToken,
			[
				"MONGODB_CAPTURE_POSITION_LOST",
				"the position is not a resume token this deployment minted",
			],
		],
	]);

/**
 * Give a refused command the meaning a caller can act on. The server message
 * is deliberately dropped; the numeric code and its name are kept as detail
 * and the original error as `cause`.
 */
export function toMongoDataError(failure: MongoCommandError): MongoDataError {
	const [code, message] = CODE_MEANING.get(failure.code) ?? [
		"MONGODB_COMMAND_FAILED",
		"MongoDB refused the command",
	];
	return new MongoDataError(code, message, {
		cause: failure,
		detail: { serverCode: failure.code, codeName: failure.codeName },
	});
}

/** True when the refusal is a duplicate `_id`: a lost race, not a failure. */
export function isDuplicateKey(cause: unknown): boolean {
	return (
		cause instanceof MongoCommandError &&
		cause.code === MONGO_SERVER_CODES.duplicateKey
	);
}
