export const MONGO_DATA_ERROR_CODES = [
	"MONGODB_INVALID_OPTIONS",
	"MONGODB_INVALID_REQUEST",
	"MONGODB_VALUE_NOT_REPRESENTABLE",
	"MONGODB_NON_CANONICAL_VALUE",
	"MONGODB_DOCUMENT_REJECTED",
	"MONGODB_DOCUMENT_TOO_LARGE",
	"MONGODB_TRANSACTIONS_UNAVAILABLE",
	"MONGODB_TRANSACTION_LIMIT",
	"MONGODB_CAPTURE_UNAVAILABLE",
	"MONGODB_CAPTURE_POSITION_LOST",
	"MONGODB_CAPTURE_UNSUPPORTED_EVENT",
	"MONGODB_CAPTURE_SUBSCRIPTION_CONFLICT",
	"MONGODB_COMMAND_FAILED",
] as const;

export type MongoDataErrorCode = (typeof MONGO_DATA_ERROR_CODES)[number];

export type MongoDataErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type MongoDataErrorOptions = {
	readonly detail?: MongoDataErrorDetail;
};

export class MongoDataError extends Error {
	readonly code: MongoDataErrorCode;
	readonly detail: MongoDataErrorDetail;

	constructor(
		code: MongoDataErrorCode,
		message: string,
		options: MongoDataErrorOptions = {},
	) {
		super(message);
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

// domain-view: the thrown form of the wire record MongoCommandFailure in data-models/data_mongodb.proto.
export interface MongoCommandFailure {
	readonly code: number;
	readonly codeName: string;
	readonly labels?: readonly string[];
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

function nameOnly(text: string): string {
	return NAME_PATTERN.test(text) ? text : "";
}

export class MongoCommandError extends Error {
	readonly code: number;
	readonly codeName: string;
	readonly labels: readonly string[];

	constructor(failure: MongoCommandFailure) {
		const code =
			Number.isInteger(failure.code) && failure.code >= 0 ? failure.code : 0;
		const codeName = nameOnly(failure.codeName);
		super(
			`MongoDB refused the command (code ${code}${codeName === "" ? "" : ` ${codeName}`})`,
		);
		this.name = "MongoCommandError";
		this.code = code;
		this.codeName = codeName;
		this.labels = Object.freeze(
			(failure.labels ?? []).map(nameOnly).filter((label) => label !== ""),
		);
	}
}

export const MONGO_SERVER_CODES = Object.freeze({
	illegalOperation: 20,
	namespaceExists: 48,
	writeConflict: 112,
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

export function toMongoDataError(failure: MongoCommandError): MongoDataError {
	const [code, message] = CODE_MEANING.get(failure.code) ?? [
		"MONGODB_COMMAND_FAILED",
		"MongoDB refused the command",
	];
	return new MongoDataError(code, message, {
		detail: {
			serverCode: failure.code,
			codeName: nameOnly(failure.codeName),
		},
	});
}

export function isDuplicateKey(cause: unknown): boolean {
	return (
		cause instanceof MongoCommandError &&
		cause.code === MONGO_SERVER_CODES.duplicateKey
	);
}
