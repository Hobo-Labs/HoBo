import {
	type AnyBulkWriteOperation,
	BSON,
	type ClientSession,
	type Db,
	type Document,
	type MongoClient,
	MongoError,
	MongoServerError,
} from "mongodb";
import {
	MONGO_SERVER_CODES,
	type MongoBulkWriteRequest,
	type MongoBulkWriteResult,
	type MongoChangeBatch,
	type MongoChangeEvent,
	MongoCommandError,
	type MongoDocument,
	type MongoEnsureCollectionRequest,
	type MongoExecutor,
	type MongoFindRequest,
	type MongoFindResult,
	type MongoSession,
	type MongoValue,
	type MongoWriteOperation,
} from "../../src/index.js";

const { EJSON, BSONError } = BSON;

const READ = Object.freeze({
	promoteValues: false,
	promoteLongs: false,
	promoteBuffers: false,
});

const TRANSACTION = Object.freeze({
	readConcern: { level: "snapshot" },
	writeConcern: { w: "majority" },
} as const);

const MAX_STATEMENT_BYTES = 16 * 1024 * 1024;

const RECORD_OPERATIONS = ["insert", "update", "replace", "delete"];

const POSITION_CODES: ReadonlySet<number> = new Set([
	MONGO_SERVER_CODES.invalidResumeToken,
	MONGO_SERVER_CODES.changeStreamFatalError,
	MONGO_SERVER_CODES.changeStreamHistoryLost,
]);

const DRAINED_AFTER_EMPTY_ROUNDS = 2;
const MAX_EMPTY_ROUNDS = 8;

export interface MongoDriverExecutorOptions {
	readonly client: MongoClient;
	readonly database: string;
	readonly awaitMs?: number;
	readonly dropDatabaseOnClose?: boolean;
	readonly closeClientOnClose?: boolean;
}

function toBson(value: MongoValue): Document {
	return EJSON.deserialize({ value }, { relaxed: false }).value;
}

function fromBson(value: Document): MongoValue {
	return EJSON.serialize({ value }, { relaxed: false }).value as MongoValue;
}

function documentFromBson(value: Document): MongoDocument {
	return fromBson(value) as MongoDocument;
}

function commandErrorFor(cause: unknown): MongoCommandError | undefined {
	if (cause instanceof MongoServerError) {
		return new MongoCommandError({
			code: Number(cause.code ?? 0),
			codeName: String(cause.codeName ?? ""),
			labels: cause.errorLabels,
		});
	}
	if (cause instanceof MongoError) {
		return new MongoCommandError({ code: 0, codeName: cause.name });
	}
	if (cause instanceof BSONError) {
		return new MongoCommandError({ code: 0, codeName: "BSONError" });
	}
	return undefined;
}

async function guarded<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (cause) {
		throw commandErrorFor(cause) ?? cause;
	}
}

function rangeFilter(
	after: MongoValue | undefined,
	before: MongoValue | undefined,
): Document {
	if (after === undefined && before === undefined) return {};
	return {
		_id: {
			...(after === undefined ? undefined : { $gt: toBson(after) }),
			...(before === undefined ? undefined : { $lt: toBson(before) }),
		},
	};
}

function sendable(statement: Document): void {
	if (BSON.calculateObjectSize(statement) >= MAX_STATEMENT_BYTES) {
		throw new MongoCommandError({
			code: MONGO_SERVER_CODES.bsonObjectTooLarge,
			codeName: "BSONObjectTooLarge",
		});
	}
}

function driverOperation(
	operation: MongoWriteOperation,
): AnyBulkWriteOperation {
	switch (operation.kind) {
		case "insert": {
			const document = toBson(operation.document);
			sendable(document);
			return { insertOne: { document } };
		}
		case "replace": {
			const replacement = toBson(operation.document);
			sendable({ q: { _id: replacement._id }, u: replacement, upsert: true });
			return {
				replaceOne: {
					filter: { _id: replacement._id },
					replacement,
					upsert: true,
				},
			};
		}
		case "delete":
			return { deleteOne: { filter: { _id: toBson(operation.id) } } };
		case "deleteRange":
			return {
				deleteMany: { filter: rangeFilter(operation.after, operation.before) },
			};
	}
}

function resumeTokenOf(cursor: Document): string {
	return String(cursor.postBatchResumeToken._data);
}

function isClosed(cursor: Document): boolean {
	return String(cursor.id) === "0";
}

function transactionOf(event: Document): string | undefined {
	if (event.lsid?.id === undefined || event.txnNumber === undefined) {
		return undefined;
	}
	return `${event.lsid.id.toString("hex")}:${String(event.txnNumber)}`;
}

function changeEvent(event: Document): MongoChangeEvent {
	const id = event.documentKey?._id;
	const transaction = transactionOf(event);
	return {
		token: String(event._id._data),
		operation: String(event.operationType),
		...(id === undefined ? undefined : { id: fromBson(id) }),
		...(event.fullDocument === undefined || event.fullDocument === null
			? undefined
			: { document: documentFromBson(event.fullDocument) }),
		...(transaction === undefined ? undefined : { transaction }),
	};
}

export function createMongoDriverExecutor(
	options: MongoDriverExecutorOptions,
): MongoExecutor {
	const { client } = options;
	const db: Db = client.db(options.database);
	const awaitMs = options.awaitMs ?? 1;

	const sessionOperations = (session?: ClientSession): MongoSession => ({
		async find(request: MongoFindRequest): Promise<MongoFindResult> {
			const filter =
				request.select.kind === "ids"
					? { _id: { $in: request.select.ids.map(toBson) } }
					: rangeFilter(request.select.after, request.select.before);
			const cursor = db
				.collection(request.collection)
				.find(filter, { ...READ, ...(session ? { session } : undefined) })
				.sort({ _id: 1 });
			if (request.limit !== undefined) cursor.limit(request.limit);
			const documents = await cursor.toArray();
			return { documents: documents.map(documentFromBson) };
		},
		async bulkWrite(
			request: MongoBulkWriteRequest,
		): Promise<MongoBulkWriteResult> {
			if (request.operations.length === 0) {
				return { inserted: 0, replaced: 0, deleted: 0 };
			}
			const result = await db
				.collection(request.collection)
				.bulkWrite(request.operations.map(driverOperation), {
					ordered: true,
					...(session ? { session } : undefined),
				});
			return {
				inserted: result.insertedCount + result.upsertedCount,
				replaced: result.matchedCount,
				deleted: result.deletedCount,
			};
		},
	});

	const openStream = (
		collection: string,
		stages: readonly Document[],
		session: ClientSession,
	): Promise<Document> =>
		db.command(
			{ aggregate: collection, pipeline: stages, cursor: { batchSize: 0 } },
			{ session, ...READ },
		);

	const opensFresh = async (collection: string): Promise<boolean> => {
		const session = client.startSession();
		try {
			const opened = await openStream(
				collection,
				[{ $changeStream: {} }],
				session,
			);
			await db
				.command(
					{ killCursors: collection, cursors: [opened.cursor.id] },
					{ session },
				)
				.catch(() => undefined);
			return true;
		} catch {
			return false;
		} finally {
			await session.endSession();
		}
	};

	const withChangeCursor = async <T>(
		collection: string,
		stages: readonly Document[],
		resumed: boolean,
		use: (
			first: Document,
			more: (size: number) => Promise<Document>,
		) => Promise<T>,
	): Promise<T> => {
		const session = client.startSession();
		try {
			const opened = await openStream(collection, stages, session).catch(
				async (cause) => {
					if (
						resumed &&
						cause instanceof MongoServerError &&
						!POSITION_CODES.has(Number(cause.code)) &&
						(await opensFresh(collection))
					) {
						throw new MongoCommandError({
							code: MONGO_SERVER_CODES.invalidResumeToken,
							codeName: "InvalidResumeToken",
						});
					}
					throw cause;
				},
			);
			const cursorId = opened.cursor.id;
			try {
				return await use(opened.cursor, async (size) => {
					const reply = await db.command(
						{
							getMore: cursorId,
							collection,
							batchSize: size,
							maxTimeMS: awaitMs,
						},
						{ session, ...READ },
					);
					return reply.cursor;
				});
			} finally {
				await db
					.command(
						{ killCursors: collection, cursors: [cursorId] },
						{ session },
					)
					.catch(() => undefined);
			}
		} finally {
			await session.endSession();
		}
	};

	const outside = sessionOperations();

	return {
		find: (request) => guarded(() => outside.find(request)),
		bulkWrite: (request) => guarded(() => outside.bulkWrite(request)),
		ensureCollection: (request: MongoEnsureCollectionRequest) =>
			guarded(async () => {
				const validation =
					request.validator === undefined
						? undefined
						: {
								validator: toBson(request.validator),
								validationLevel: "strict",
								validationAction: "error",
							};
				const converge = async (): Promise<{ created: boolean }> => {
					if (validation !== undefined || request.changeImages) {
						await db.command({
							collMod: request.collection,
							...(validation ?? { validator: {} }),
							changeStreamPreAndPostImages: { enabled: request.changeImages },
						});
					}
					return { created: false };
				};
				const existing = await db
					.listCollections({ name: request.collection }, { nameOnly: true })
					.toArray();
				if (existing.length > 0) return converge();
				try {
					await db.createCollection(request.collection, {
						...validation,
						...(request.changeImages
							? { changeStreamPreAndPostImages: { enabled: true } }
							: undefined),
					});
					return { created: true };
				} catch (cause) {
					if (
						cause instanceof MongoServerError &&
						cause.code === MONGO_SERVER_CODES.namespaceExists
					) {
						return converge();
					}
					throw cause;
				}
			}),
		transaction: <T>(body: (session: MongoSession) => Promise<T>) =>
			guarded(async () => {
				const session = client.startSession();
				try {
					return await session.withTransaction(
						() => body(sessionOperations(session)),
						TRANSACTION,
					);
				} finally {
					await session.endSession();
				}
			}),
		awaitTransactions: (request) =>
			guarded(async () => {
				await db.command({ collMod: request.collection });
			}),
		changeHead: (request) =>
			guarded(() =>
				withChangeCursor(
					request.collection,
					[{ $changeStream: {} }],
					false,
					async (first) => ({ token: resumeTokenOf(first) }),
				),
			),
		readChanges: (request) =>
			guarded(() =>
				withChangeCursor(
					request.collection,
					[
						{
							$changeStream: {
								fullDocument: "required",
								resumeAfter: { _data: request.after },
							},
						},
						...(request.where === undefined
							? []
							: [
									{
										$match: {
											$or: [
												{
													[`documentKey.${request.where.path}`]: toBson(
														request.where.equals,
													),
												},
												{ operationType: { $nin: RECORD_OPERATIONS } },
											],
										},
									},
								]),
					],
					true,
					async (first, more): Promise<MongoChangeBatch> => {
						const events: Document[] = [];
						let token = resumeTokenOf(first);
						let emptyRounds = 0;
						let drained = isClosed(first);
						let round = 0;
						while (
							!drained &&
							events.length <= request.limit &&
							round < MAX_EMPTY_ROUNDS
						) {
							const next = await more(request.limit + 1 - events.length);
							const nextToken = resumeTokenOf(next);
							if (next.nextBatch.length > 0) {
								events.push(...next.nextBatch);
								emptyRounds = 0;
							} else {
								emptyRounds = nextToken === token ? emptyRounds + 1 : 1;
								round += 1;
							}
							token = nextToken;
							drained =
								isClosed(next) || emptyRounds >= DRAINED_AFTER_EMPTY_ROUNDS;
						}
						if (events.length > request.limit) {
							const page = events.slice(0, request.limit).map(changeEvent);
							return {
								events: page,
								token: page[page.length - 1]?.token ?? request.after,
								drained: false,
							};
						}
						return { events: events.map(changeEvent), token, drained };
					},
				),
			),
		close: async () => {
			if (options.dropDatabaseOnClose === true) await db.dropDatabase();
			if (options.closeClientOnClose === true) await client.close();
		},
	};
}
