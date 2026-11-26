// The reference `MongoExecutor` adapter over the official `mongodb` driver.
//
// It lives under test/ because the driver is a devDependency: the runtime
// package imports no driver, and a host that wants MongoDB brings its own
// client and an adapter like this one. Everything here is a mechanical
// translation — the port's closed request records into driver calls, and
// canonical Extended JSON to and from BSON with the driver's own EJSON.
//
// Six things in it are load-bearing and easy to get wrong:
//
// - reads use `promoteValues: false`, or the driver would hand back an int64
//   as a JavaScript number and silently lose everything beyond 2^53;
// - errors raised inside a transaction body pass through untouched, because
//   `withTransaction` retries on the driver's own error labels and cannot see
//   them once the error has been translated;
// - a driver error is translated to its code and name and then dropped. It is
//   never chained as `cause`: its message quotes keys, documents, and the
//   address the client dialled;
// - change streams are driven with raw `aggregate` / `getMore` commands, not
//   `watch()`, so the adapter sees every batch boundary and resume token and
//   can say truthfully whether the stream was drained;
// - a key filter on a change stream lets every event that is not about one
//   document through, or a tenant-scoped reader would never see a drop;
// - a resume token the server cannot decode is reported as code 260. The
//   server has no one code for it, so the adapter asks the only question that
//   settles it: does the same stream open without the token?
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

/** Keep every BSON number as its own type; never promote to a JS number. */
const READ = Object.freeze({
	promoteValues: false,
	promoteLongs: false,
	promoteBuffers: false,
});

const TRANSACTION = Object.freeze({
	readConcern: { level: "snapshot" },
	writeConcern: { w: "majority" },
} as const);

/**
 * The driver refuses a write statement of this size or more before sending
 * it, with an error that has a message and no code.
 */
const MAX_STATEMENT_BYTES = 16 * 1024 * 1024;

/** The operations that are about one document: the ones a key filter judges. */
const RECORD_OPERATIONS = ["insert", "update", "replace", "delete"];

/** Refusals of a stream that already say what is wrong with the position. */
const POSITION_CODES: ReadonlySet<number> = new Set([
	MONGO_SERVER_CODES.invalidResumeToken,
	MONGO_SERVER_CODES.changeStreamFatalError,
	MONGO_SERVER_CODES.changeStreamHistoryLost,
]);

/** Empty `getMore` rounds, at one unchanged resume point, that mean drained. */
const DRAINED_AFTER_EMPTY_ROUNDS = 2;
const MAX_EMPTY_ROUNDS = 8;

export interface MongoDriverExecutorOptions {
	readonly client: MongoClient;
	readonly database: string;
	/** How long an empty `getMore` waits for a new event. Defaults to 1 ms. */
	readonly awaitMs?: number;
	/** Drop the database on `close()`. For test isolation only. */
	readonly dropDatabaseOnClose?: boolean;
	/** Close the client on `close()`. Leave unset when the client is shared. */
	readonly closeClientOnClose?: boolean;
}

function toBson(value: MongoValue): Document {
	return EJSON.deserialize({ value }, { relaxed: false }).value;
}

function fromBson(value: Document): MongoValue {
	// SAFETY: canonical EJSON.serialize returns plain JSON by construction.
	return EJSON.serialize({ value }, { relaxed: false }).value as MongoValue;
}

function documentFromBson(value: Document): MongoDocument {
	// SAFETY: a BSON document serializes to a JSON object, never a scalar.
	return fromBson(value) as MongoDocument;
}

/**
 * What survives of a driver error: its code, its code name, its labels. The
 * error itself is not kept — not as `cause`, not anywhere.
 */
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

/** Translate a driver refusal into the port's error; pass the rest through. */
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

/**
 * Refuse a statement the driver would refuse, under the code a server gives a
 * document that is too large. The driver measures the whole statement — for a
 * replace, the filter and the replacement together — so its limit sits a few
 * dozen bytes below 16 MiB of document.
 */
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

/** A server-closed cursor reports id 0. */
function isClosed(cursor: Document): boolean {
	return String(cursor.id) === "0";
}

/**
 * Session id and transaction number: together they name one transaction, and
 * a change event carries both exactly when it was made inside one.
 */
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

	/**
	 * Open a change stream, returning no events yet: the open then fails only
	 * for what is wrong with the stream itself, never for an event in it.
	 */
	const openStream = (
		collection: string,
		stages: readonly Document[],
		session: ClientSession,
	): Promise<Document> =>
		db.command(
			{ aggregate: collection, pipeline: stages, cursor: { batchSize: 0 } },
			{ session, ...READ },
		);

	/** True when the collection's stream opens from "now". */
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

	/**
	 * A change stream as raw commands, so every batch boundary is visible.
	 * `resumed` says the stream opens at a caller's token: if the server then
	 * refuses to open it, with a code that does not already name the position,
	 * and the same stream opens without the token, the token is what it
	 * refused.
	 */
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
					// Driver errors raised by `body` reach withTransaction
					// unchanged: it retries on their labels.
					return await session.withTransaction(
						() => body(sessionOperations(session)),
						TRANSACTION,
					);
				} finally {
					await session.endSession();
				}
			}),
		// A no-op collMod takes the collection's exclusive lock, which is
		// granted only once every transaction holding an intent lock on it —
		// every transaction that has read or written it — has finished.
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
								// `required`: an update with no post-image fails the
								// read. `updateLookup` would return today's document.
								fullDocument: "required",
								resumeAfter: { _data: request.after },
							},
						},
						...(request.where === undefined
							? []
							: [
									{
										// A drop, a rename, or an invalidate has no
										// document key. It must still reach the reader.
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
						// An invalidate (the collection was dropped or renamed)
						// closes the cursor: nothing further will ever come.
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
								// An empty batch means the scan reached the end of
								// the committed oplog. Twice at one resume point
								// means it stayed there.
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
