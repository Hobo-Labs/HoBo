/**
 * The MongoDB engine binding: the `@hobo/data-core` SPI over an injected
 * `MongoExecutor`.
 *
 * Layout in one database:
 *
 * - one collection per dataset, named after it, holding one document per
 *   record (`./codec.ts`), created with a `$jsonSchema` validator and — when
 *   capture is on — the change-image option, so an in-place update by another
 *   client still has a post-image to capture;
 * - one metadata collection holding the dataset schemas, the raised fences,
 *   the apply watermarks, and the capture subscriptions.
 *
 * Every write that goes through the binding is one multi-document
 * transaction whose first statement reads the fences. That is the whole of
 * the fence: MongoDB has no triggers, so nothing stops a client that holds
 * its own connection, and the declaration says `entry-point`.
 */
import { randomUUID } from "node:crypto";
import {
	type CanonicalRecord,
	type CaptureBatch,
	type ChangeEnvelope,
	canonicalEncode,
	DataCoreError,
	type DatasetDigest,
	DatasetDigestBuilder,
	type DatasetSchema,
	type DatasetScope,
	deleteMutation,
	type EngineBinding,
	envelopeOf,
	FencedWriteError,
	type JsonValue,
	parseDatasetSchema,
	type RecordMutation,
	type SnapshotCursor,
	schemaDigest,
	schemaToJson,
	upsertMutation,
} from "@hobo/data-core";
import {
	datasetValidator,
	decodeDocument,
	documentId,
	encodeDocument,
	identityOf,
	storableText,
} from "./codec.js";
import { mongoEngineDeclaration } from "./declaration.js";
import {
	isDuplicateKey,
	MongoCommandError,
	MongoDataError,
	toMongoDataError,
} from "./errors.js";
import type {
	MongoChangeBatch,
	MongoChangeEvent,
	MongoExecutor,
	MongoIdRange,
	MongoSession,
	MongoWriteOperation,
} from "./executor.js";
import {
	MONGO_MAX_KEY,
	MONGO_MIN_KEY,
	type MongoDocument,
	type MongoValue,
} from "./extended-json.js";
import { isJsonString } from "./json.js";

// public-contract: default name of the metadata collection the binding keeps beside the datasets.
export const MONGO_METADATA_COLLECTION = "_hobo_data_engine";

export const MONGO_DEFAULT_SCAN_PAGE = 500;

const METADATA_NAME_PATTERN = /^_[a-z0-9_]{1,62}$/u;
const OPERATION_PATTERN = /^[A-Za-z]{1,64}$/u;

export interface MongoEngineOptions {
	/** The executor every operation goes through. The binding owns its close. */
	readonly executor: MongoExecutor;
	/**
	 * Change streams need a replica set or a sharded cluster. Pass `false` for
	 * a deployment that cannot open them: the binding then has no `capture`
	 * port and its declaration says so. Defaults to `true`.
	 */
	readonly capture?: boolean;
	/**
	 * Name of the metadata collection. It must start with `_`, which no
	 * dataset name can, so it can never collide with a dataset's collection.
	 */
	readonly metadataCollection?: string;
	/** Documents per round trip when digesting or retiring a scope. */
	readonly scanPageSize?: number;
	/** Mints a fence token. Defaults to a random, unguessable one. */
	readonly mintFenceToken?: () => string;
}

/** Engine options after the one parse: every field present and in range. */
// domain-view: parsed options, constructible only through parseMongoEngineOptions; the wire record MongoEngineSettings in data-models/data_mongodb.proto carries its non-secret fields, never the executor.
export interface MongoEngineSettings {
	readonly executor: MongoExecutor;
	readonly capture: boolean;
	readonly metadataCollection: string;
	readonly scanPageSize: number;
	readonly mintFenceToken: () => string;
}

function invalidOptions(message: string, field: string): never {
	throw new MongoDataError("MONGODB_INVALID_OPTIONS", message, {
		detail: { field },
	});
}

/** The one constructor for `MongoEngineSettings`. Invalid options throw. */
export function parseMongoEngineOptions(
	options: MongoEngineOptions,
): MongoEngineSettings {
	const metadataCollection =
		options.metadataCollection ?? MONGO_METADATA_COLLECTION;
	if (!METADATA_NAME_PATTERN.test(metadataCollection)) {
		invalidOptions(
			"metadataCollection must be `_` followed by lowercase letters, digits, or underscores, so it cannot be a dataset name",
			"metadataCollection",
		);
	}
	const scanPageSize = options.scanPageSize ?? MONGO_DEFAULT_SCAN_PAGE;
	if (!Number.isInteger(scanPageSize) || scanPageSize < 1) {
		invalidOptions("scanPageSize must be a positive integer", "scanPageSize");
	}
	return Object.freeze({
		executor: options.executor,
		capture: options.capture ?? true,
		metadataCollection,
		scanPageSize,
		mintFenceToken: options.mintFenceToken ?? (() => `fence:${randomUUID()}`),
	});
}

function invalidRequest(message: string, field: string): never {
	throw new MongoDataError("MONGODB_INVALID_REQUEST", message, {
		detail: { field },
	});
}

function positiveInteger(value: number, field: string): number {
	return Number.isInteger(value) && value >= 1
		? value
		: invalidRequest(`${field} must be a positive integer`, field);
}

/** Refused commands become errors a caller can act on; the rest pass through. */
async function mapped<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (cause) {
		if (cause instanceof MongoCommandError) throw toMongoDataError(cause);
		throw cause;
	}
}

// ── metadata entries ────────────────────────────────────────────────────────

function metadataId(kind: string, ...parts: readonly string[]): string {
	// Dataset names are identifiers and never contain `:`, so the id parses
	// unambiguously even when a tenant or a source name does.
	return [kind, ...parts.map((part) => storableText(part, kind, "key"))].join(
		":",
	);
}

function textField(
	document: MongoDocument | undefined,
	field: string,
): string | undefined {
	const value = document?.[field];
	return isJsonString(value) ? value : undefined;
}

/** The `_id` range that is exactly one scope, optionally past a cursor. */
function scopeRange(scope: DatasetScope, after?: MongoValue): MongoIdRange {
	if (scope.tenant === "") {
		return after === undefined ? { kind: "range" } : { kind: "range", after };
	}
	const tenant = storableText(scope.tenant, "tenant", "key");
	return {
		kind: "range",
		after: after ?? { t: tenant, k: MONGO_MIN_KEY },
		before: { t: tenant, k: MONGO_MAX_KEY },
	};
}

/** True when two consecutive events were committed by one transaction. */
function sameTransaction(
	earlier: MongoChangeEvent | undefined,
	later: MongoChangeEvent | undefined,
): boolean {
	return (
		earlier?.transaction !== undefined &&
		earlier.transaction === later?.transaction
	);
}

function retireRefused(dataset: string, message: string): never {
	throw new DataCoreError("RETIRE_REFUSED", message, { detail: { dataset } });
}

export function createMongoEngine(options: MongoEngineOptions): EngineBinding {
	const settings = parseMongoEngineOptions(options);
	const { executor, metadataCollection, scanPageSize } = settings;
	const schemas = new Map<string, DatasetSchema>();
	let metadataReady: Promise<void> | undefined;

	const ensureMetadata = (): Promise<void> => {
		metadataReady ??= executor
			.ensureCollection({ collection: metadataCollection, changeImages: false })
			.then(
				() => undefined,
				(cause) => {
					metadataReady = undefined;
					throw cause;
				},
			);
		return metadataReady;
	};

	const entry = async (
		reader: MongoSession,
		id: string,
	): Promise<MongoDocument | undefined> => {
		const { documents } = await reader.find({
			collection: metadataCollection,
			select: { kind: "ids", ids: [id] },
		});
		return documents[0];
	};

	/** Insert a metadata entry; false when another writer got there first. */
	const insertEntry = async (document: MongoDocument): Promise<boolean> => {
		try {
			await executor.bulkWrite({
				collection: metadataCollection,
				operations: [{ kind: "insert", document }],
			});
			return true;
		} catch (cause) {
			if (isDuplicateKey(cause)) return false;
			throw cause;
		}
	};

	const loadSchema = async (
		name: string,
	): Promise<DatasetSchema | undefined> => {
		const cached = schemas.get(name);
		if (cached !== undefined) return cached;
		const text = textField(
			await entry(executor, metadataId("dataset", name)),
			"schema",
		);
		if (text === undefined) return undefined;
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		const schema = parseDatasetSchema(JSON.parse(text) as JsonValue);
		// A stored schema never changes — a differing one is refused — so the
		// cache cannot go stale.
		schemas.set(name, schema);
		return schema;
	};

	const requireDataset = async (name: string): Promise<DatasetSchema> => {
		const schema = await loadSchema(name);
		if (schema === undefined) {
			throw new DataCoreError(
				"INVALID_RECORD",
				`dataset ${name} does not exist`,
				{ detail: { dataset: name } },
			);
		}
		return schema;
	};

	/**
	 * The fence check. It runs as the first statement of the transaction that
	 * carries the write, so the write and the check see one snapshot.
	 */
	const assertWritable = async (
		session: MongoSession,
		dataset: string,
		mutations: readonly RecordMutation[],
		fenceToken: string | undefined,
	): Promise<void> => {
		if (mutations.length === 0) return;
		const tenants = [
			...new Set(["", ...mutations.map((mutation) => mutation.tenant)]),
		];
		const { documents } = await session.find({
			collection: metadataCollection,
			select: {
				kind: "ids",
				ids: tenants.map((tenant) => metadataId("fence", dataset, tenant)),
			},
		});
		const fenced = new Set(
			documents
				.filter((document) => textField(document, "token") !== fenceToken)
				.map((document) => textField(document, "tenant") ?? ""),
		);
		if (fenced.size === 0) return;
		const blocked = mutations.find(
			(mutation) => fenced.has("") || fenced.has(mutation.tenant),
		);
		if (blocked !== undefined) {
			throw new FencedWriteError(dataset, blocked.tenant);
		}
	};

	const operationsFor = (
		schema: DatasetSchema,
		mutations: readonly RecordMutation[],
	): MongoWriteOperation[] =>
		mutations.map((mutation): MongoWriteOperation => {
			if (mutation.op === "delete") {
				return {
					kind: "delete",
					id: documentId(mutation.tenant, mutation.key),
				};
			}
			if (mutation.record === undefined) {
				throw new DataCoreError(
					"INVALID_RECORD",
					"an upsert carries a record",
					{
						detail: { field: "record" },
					},
				);
			}
			// A whole-document replace: its change event carries the document
			// as of this change without any lookup.
			return {
				kind: "replace",
				document: encodeDocument(
					schema,
					mutation.tenant,
					mutation.key,
					mutation.record,
				),
			};
		});

	/** Fold a scope into a digest, a page at a time, through any reader. */
	const digestScope = async (
		reader: MongoSession,
		schema: DatasetSchema,
		scope: DatasetScope,
		buckets: number,
	): Promise<DatasetDigest> => {
		const builder = new DatasetDigestBuilder(
			scope.dataset,
			scope.tenant,
			buckets,
		);
		let after: MongoValue | undefined;
		for (;;) {
			const { documents } = await reader.find({
				collection: scope.dataset,
				select: scopeRange(scope, after),
				limit: scanPageSize,
			});
			for (const document of documents) {
				const { tenant, key, record } = decodeDocument(schema, document);
				builder.add(tenant, key, record);
			}
			after = documents[documents.length - 1]?._id;
			if (documents.length < scanPageSize || after === undefined) break;
		}
		return builder.finish();
	};

	const openSnapshot = (
		schema: DatasetSchema,
		scope: DatasetScope,
		chunkSize: number,
	): SnapshotCursor => {
		let after: MongoValue | undefined;
		let done = false;
		return {
			next: () =>
				mapped(async () => {
					if (done) return undefined;
					// A keyset scan: each chunk resumes after the last `_id` seen,
					// so a concurrent write can neither repeat nor skip a record
					// that was present throughout. It is still a fuzzy image.
					const { documents } = await executor.find({
						collection: scope.dataset,
						select: scopeRange(scope, after),
						limit: chunkSize,
					});
					after = documents[documents.length - 1]?._id;
					if (documents.length < chunkSize) done = true;
					if (documents.length === 0) return undefined;
					return documents.map((document) => {
						const { tenant, key, record } = decodeDocument(schema, document);
						return upsertMutation(tenant, key, record);
					});
				}),
			close: async () => {
				done = true;
			},
		};
	};

	const subscriptionEntry = (
		subscription: string,
		scope: DatasetScope,
		start: string,
	): MongoDocument => ({
		_id: metadataId("subscription", subscription),
		kind: "subscription",
		subscription,
		dataset: scope.dataset,
		tenant: scope.tenant,
		start,
	});

	/**
	 * The start of a stored subscription, for the scope it was started on. A
	 * subscription is one reader of one scope: the same name on another
	 * dataset or tenant is refused, because handing back the first scope's
	 * position would start the second reader at a point that means nothing to
	 * it.
	 */
	const startOf = (
		stored: MongoDocument | undefined,
		scope: DatasetScope,
	): string | undefined => {
		const start = textField(stored, "start");
		if (start === undefined) return undefined;
		if (
			textField(stored, "dataset") !== scope.dataset ||
			textField(stored, "tenant") !== scope.tenant
		) {
			throw new MongoDataError(
				"MONGODB_CAPTURE_SUBSCRIPTION_CONFLICT",
				"the subscription already reads another dataset or tenant; stop it or choose another name",
				{ detail: { field: "subscription" } },
			);
		}
		return start;
	};

	/**
	 * Read up to `limit` events, then on to the end of the transaction the
	 * last of them belongs to. A resume token can sit in the middle of a
	 * transaction, so a page cut at `limit` alone could hand a reader half of
	 * one atomic write.
	 */
	const readWholeTransactions = async (
		scope: DatasetScope,
		after: string,
		limit: number,
	): Promise<MongoChangeBatch> => {
		// One event more than asked for: in the usual case it is the proof
		// that the page may end where the limit says.
		const size = limit + 1;
		const events: MongoChangeEvent[] = [];
		let from = after;
		for (;;) {
			const batch = await executor.readChanges({
				collection: scope.dataset,
				after: from,
				limit: size,
				...(scope.tenant === ""
					? undefined
					: { where: { path: "_id.t", equals: scope.tenant } }),
			});
			events.push(...batch.events);
			let end = limit;
			while (
				end < events.length &&
				sameTransaction(events[end - 1], events[end])
			) {
				end += 1;
			}
			const last = events[end - 1];
			if (end < events.length && last !== undefined) {
				return {
					events: events.slice(0, end),
					token: last.token,
					drained: false,
				};
			}
			// Everything read is returned. Only a full page can have stopped
			// inside a transaction; anything shorter ended between two.
			if (batch.drained || batch.events.length < size) {
				return { events, token: batch.token, drained: batch.drained };
			}
			from = batch.token;
		}
	};

	const capture: NonNullable<EngineBinding["capture"]> = {
		start: (request) =>
			mapped(async () => {
				const id = metadataId("subscription", request.subscription);
				const existing = startOf(await entry(executor, id), request.scope);
				if (existing !== undefined) return existing;
				await requireDataset(request.scope.dataset);
				// The stream's current resume point. Everything committed before
				// it is in the snapshot's past; everything after it is replayed.
				const { token } = await executor.changeHead({
					collection: request.scope.dataset,
				});
				if (
					await insertEntry(
						subscriptionEntry(request.subscription, request.scope, token),
					)
				) {
					return token;
				}
				// Lost a race to start the same subscription: its position wins.
				return startOf(await entry(executor, id), request.scope) ?? token;
			}),
		read: (request) =>
			mapped(async (): Promise<CaptureBatch> => {
				const schema = await requireDataset(request.scope.dataset);
				const batch = await readWholeTransactions(
					request.scope,
					request.after,
					positiveInteger(request.limit, "limit"),
				);
				const changes = batch.events.map((event): ChangeEnvelope => {
					if (event.operation === "delete") {
						const { tenant, key } = identityOf(event.id);
						return envelopeOf(schema, deleteMutation(tenant, key), event.token);
					}
					if (
						event.document !== undefined &&
						["insert", "replace", "update"].includes(event.operation)
					) {
						const { tenant, key, record } = decodeDocument(
							schema,
							event.document,
						);
						return envelopeOf(
							schema,
							upsertMutation(tenant, key, record),
							event.token,
						);
					}
					// A drop, a rename, an invalidate — or an update an executor
					// delivered without its post-image: not a record change this
					// contract can carry, and not something to skip silently.
					// An operation type is a word. Anything else an executor put
					// there is not quoted back.
					const operation = OPERATION_PATTERN.test(event.operation)
						? event.operation
						: "unnamed";
					throw new MongoDataError(
						"MONGODB_CAPTURE_UNSUPPORTED_EVENT",
						`the change stream reported a ${operation} event that is not a record change`,
						{ detail: { operation } },
					);
				});
				return {
					changes,
					position: batch.token,
					caughtUp: batch.drained,
				};
			}),
		// MongoDB keeps no per-reader log: retention is the oplog window, and
		// nothing an acknowledgement could release.
		acknowledge: async () => undefined,
		stop: (subscription) =>
			mapped(async () => {
				await executor.bulkWrite({
					collection: metadataCollection,
					operations: [
						{ kind: "delete", id: metadataId("subscription", subscription) },
					],
				});
			}),
	};

	const binding: EngineBinding = {
		declaration: mongoEngineDeclaration({ capture: settings.capture }),
		datasets: {
			ensureDataset: (schema) =>
				mapped(async () => {
					await ensureMetadata();
					const refuseDifferent = (existing: DatasetSchema): void => {
						if (schemaDigest(existing) !== schemaDigest(schema)) {
							throw new DataCoreError(
								"INVALID_DATASET_SCHEMA",
								`dataset ${schema.name} exists with a different schema`,
								{ detail: { dataset: schema.name } },
							);
						}
					};
					const existing = await loadSchema(schema.name);
					if (existing !== undefined) {
						refuseDifferent(existing);
						return { dataset: schema.name, created: false };
					}
					// Collection first, entry second: a crash between the two
					// leaves a collection with no entry, which the next call
					// converges, never an entry that points at nothing.
					await executor.ensureCollection({
						collection: schema.name,
						validator: datasetValidator(schema),
						changeImages: settings.capture,
					});
					const created = await insertEntry({
						_id: metadataId("dataset", schema.name),
						kind: "dataset",
						dataset: schema.name,
						schema: canonicalEncode(schemaToJson(schema)),
						schemaDigest: schemaDigest(schema),
					});
					if (!created) {
						refuseDifferent(await requireDataset(schema.name));
						return { dataset: schema.name, created: false };
					}
					schemas.set(schema.name, schema);
					return { dataset: schema.name, created: true };
				}),
			describeDataset: (name) => mapped(() => loadSchema(name)),
		},
		records: {
			write: (request) =>
				mapped(async () => {
					const schema = await requireDataset(request.dataset);
					// Encoded before the transaction opens: a value the store
					// cannot hold is refused before anything is written.
					const operations = operationsFor(schema, request.mutations);
					if (operations.length === 0) return { applied: 0 };
					await executor.transaction(async (session) => {
						await assertWritable(
							session,
							request.dataset,
							request.mutations,
							request.fenceToken,
						);
						await session.bulkWrite({
							collection: request.dataset,
							operations,
						});
					});
					return { applied: operations.length };
				}),
			read: (request) =>
				mapped(async (): Promise<CanonicalRecord | undefined> => {
					const schema = await requireDataset(request.dataset);
					const { documents } = await executor.find({
						collection: request.dataset,
						select: {
							kind: "ids",
							ids: [documentId(request.tenant, request.key)],
						},
					});
					const document = documents[0];
					return document === undefined
						? undefined
						: decodeDocument(schema, document).record;
				}),
		},
		snapshot: {
			openSnapshot: (request) =>
				mapped(async () =>
					openSnapshot(
						await requireDataset(request.scope.dataset),
						request.scope,
						positiveInteger(request.chunkSize, "chunkSize"),
					),
				),
		},
		...(settings.capture ? { capture } : undefined),
		apply: {
			apply: (request) =>
				mapped(async () => {
					const schema = await requireDataset(request.dataset);
					const operations = operationsFor(schema, request.changes);
					// Changes and watermark commit together or not at all, so a
					// redelivered batch finds either both or neither.
					await executor.transaction(async (session) => {
						await assertWritable(
							session,
							request.dataset,
							request.changes,
							request.fenceToken,
						);
						if (operations.length > 0) {
							await session.bulkWrite({
								collection: request.dataset,
								operations,
							});
						}
						await session.bulkWrite({
							collection: metadataCollection,
							operations: [
								{
									kind: "replace",
									document: {
										_id: metadataId(
											"watermark",
											request.dataset,
											request.source,
										),
										kind: "watermark",
										dataset: request.dataset,
										source: request.source,
										position: request.position,
									},
								},
							],
						});
					});
					return { applied: operations.length };
				}),
			watermark: (request) =>
				mapped(async () => {
					await requireDataset(request.dataset);
					return textField(
						await entry(
							executor,
							metadataId("watermark", request.dataset, request.source),
						),
						"position",
					);
				}),
		},
		verify: {
			digest: (request) =>
				mapped(async () =>
					digestScope(
						executor,
						await requireDataset(request.scope.dataset),
						request.scope,
						request.buckets,
					),
				),
		},
		fence: {
			raise: (request) =>
				mapped(async () => {
					const { dataset, tenant } = request.scope;
					await requireDataset(dataset);
					const id = metadataId("fence", dataset, tenant);
					let fenceToken = textField(await entry(executor, id), "token");
					if (fenceToken === undefined) {
						const minted = settings.mintFenceToken();
						const raised = await insertEntry({
							_id: id,
							kind: "fence",
							dataset,
							tenant,
							token: minted,
							reason: storableText(request.reason, "reason", "key"),
						});
						fenceToken = raised
							? minted
							: (textField(await entry(executor, id), "token") ?? minted);
					}
					// A writer that read "not fenced" just before the fence
					// committed may still be in flight. Wait it out, so that
					// once raise returns no unfenced write can land.
					await executor.awaitTransactions({ collection: metadataCollection });
					return { fenceToken };
				}),
			release: (request) =>
				mapped(async () => {
					const { dataset, tenant } = request.scope;
					await requireDataset(dataset);
					const id = metadataId("fence", dataset, tenant);
					await executor.transaction(async (session) => {
						const token = textField(await entry(session, id), "token");
						if (token === undefined) return;
						if (token !== request.fenceToken) {
							throw new DataCoreError(
								"FENCE_TOKEN_MISMATCH",
								"only the fence token holder may release a fence",
								{ detail: { dataset } },
							);
						}
						await session.bulkWrite({
							collection: metadataCollection,
							operations: [{ kind: "delete", id }],
						});
					});
				}),
			status: (scope) =>
				mapped(async () => {
					await requireDataset(scope.dataset);
					const found = await entry(
						executor,
						metadataId("fence", scope.dataset, scope.tenant),
					);
					return { fenced: found !== undefined };
				}),
		},
		retire: {
			retire: (request) =>
				mapped(async () => {
					const { scope, expected } = request;
					const schema = await requireDataset(scope.dataset);
					// Token check, digest, and delete share one snapshot: the
					// scope that is deleted is exactly the scope that was proven.
					return executor.transaction(async (session) => {
						const token = textField(
							await entry(
								session,
								metadataId("fence", scope.dataset, scope.tenant),
							),
							"token",
						);
						if (token === undefined || token !== request.fenceToken) {
							retireRefused(
								scope.dataset,
								"retire needs the raised fence's token; the store may still be authoritative",
							);
						}
						const current = await digestScope(
							session,
							schema,
							scope,
							expected.buckets.length,
						);
						if (
							current.count !== expected.count ||
							current.digest !== expected.digest
						) {
							// A redelivered retire. The scope is empty and the
							// fence is still held by this token, so an earlier
							// delivery already removed it: nothing is left to
							// prove, and nothing is left to remove.
							if (current.count === 0) return { removed: 0 };
							retireRefused(
								scope.dataset,
								"the store no longer matches the verified digest",
							);
						}
						const { after, before } = scopeRange(scope);
						const result = await session.bulkWrite({
							collection: scope.dataset,
							operations: [
								{
									kind: "deleteRange",
									...(after === undefined ? undefined : { after }),
									...(before === undefined ? undefined : { before }),
								},
							],
						});
						return { removed: result.deleted };
					});
				}),
		},
		close: () => executor.close(),
	};
	return Object.freeze(binding);
}
