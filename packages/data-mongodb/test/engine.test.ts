// The binding itself: what it declares, how it maps a refused command, and
// the behaviours the conformance kit does not reach — persistence across
// bindings, atomic refusal, and where the fence sits.
import assert from "node:assert/strict";
import {
	type Awaitable,
	assertBindingMatchesDeclaration,
	CANONICAL_TYPES,
	type CanonicalRecord,
	DataCoreError,
	type DatasetSchema,
	deleteMutation,
	type EngineBinding,
	encodeRecordKey,
	engineDeclarationToJson,
	FencedWriteError,
	type JsonObject,
	parseCanonicalRecord,
	parseDatasetSchema,
	parseEngineDeclaration,
	type RecordMutation,
	requirePort,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import {
	createMemoryMongoExecutor,
	createMongoEngine,
	HOBO_DATA_MONGODB_PACKAGE,
	isMongoDataError,
	MONGO_DATA_ERROR_CODES,
	MONGO_ENGINE_ID,
	MONGO_ENGINE_PROFILE,
	MONGO_IMPEDANCE_CODES,
	MONGO_METADATA_COLLECTION,
	MONGO_SERVER_CODES,
	MongoCommandError,
	MongoDataError,
	type MongoDataErrorCode,
	type MongoExecutor,
	mongoEngineDeclaration,
	parseFindRequest,
	parseMongoEngineOptions,
	toMongoDataError,
} from "../src/index.js";

const SCHEMA: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string" },
		{ name: "qty", type: "int64" },
		{ name: "price", type: "decimal", nullable: true },
		{ name: "note", type: "string", nullable: true },
	],
});

function upsert(
	tenant: string,
	id: string,
	fields: JsonObject = {},
): RecordMutation {
	const record: CanonicalRecord = parseCanonicalRecord(SCHEMA, {
		id,
		qty: "1",
		...fields,
	});
	return upsertMutation(tenant, encodeRecordKey(SCHEMA, record), record);
}

function keyOf(id: string): string {
	return upsert("", id).key;
}

async function open(
	executor: MongoExecutor = createMemoryMongoExecutor(),
): Promise<EngineBinding> {
	const binding = createMongoEngine({ executor });
	await binding.datasets.ensureDataset(SCHEMA);
	return binding;
}

async function rejection<T>(action: () => Awaitable<T>): Promise<Error> {
	try {
		await action();
	} catch (cause) {
		assert.ok(cause instanceof Error, String(cause));
		return cause;
	}
	return assert.fail("expected a rejection");
}

async function count(binding: EngineBinding, tenant = ""): Promise<number> {
	const digest = await requirePort(binding, "verify").digest({
		scope: scopeOf(SCHEMA.name, tenant),
		buckets: 4,
	});
	return digest.count;
}

describe("declaration", () => {
	test("the declaration is valid, round-trips as JSON, and matches the binding", () => {
		const binding = createMongoEngine({
			executor: createMemoryMongoExecutor(),
		});
		const { declaration } = binding;
		assert.deepEqual(
			parseEngineDeclaration(engineDeclarationToJson(declaration)),
			declaration,
		);
		assertBindingMatchesDeclaration(binding);
		assert.equal(declaration.engine, MONGO_ENGINE_ID);
		assert.equal(declaration.profile, MONGO_ENGINE_PROFILE);
		assert.equal(declaration.profile, "data.mongodb/v1");
		assert.equal(declaration.paradigm, "document");
		assert.deepEqual(declaration.ports, [
			"datasets",
			"records",
			"snapshot",
			"capture",
			"apply",
			"verify",
			"fence",
			"retire",
		]);
		assert.equal(declaration.captureOrdering, "global");
		assert.equal(declaration.snapshotConsistency, "fuzzy");
		assert.equal(declaration.ddlTransactional, false);
		assert.deepEqual(declaration.nativeProfiles, []);
	});

	test("MongoDB has no triggers: the fence is declared entry-point, and there is no schema port", () => {
		const binding = createMongoEngine({
			executor: createMemoryMongoExecutor(),
		});
		assert.equal(binding.declaration.fenceEnforcement, "entry-point");
		assert.ok(!binding.declaration.ports.includes("schema"));
		assert.equal(binding.schema, undefined);
		assert.ok(
			binding.declaration.impedance.includes("MONGODB_FENCE_ENTRY_POINT"),
		);
		assert.ok(binding.declaration.impedance.includes("MONGODB_NO_SCHEMA_PORT"));
	});

	test("without change streams the capture port is absent and the declaration says so", () => {
		const binding = createMongoEngine({
			executor: createMemoryMongoExecutor(),
			capture: false,
		});
		assertBindingMatchesDeclaration(binding);
		assert.equal(binding.capture, undefined);
		assert.ok(!binding.declaration.ports.includes("capture"));
		assert.equal(binding.declaration.captureOrdering, "none");
		assert.deepEqual(
			binding.declaration,
			mongoEngineDeclaration({ capture: false }),
		);
	});

	test("the annex covers every canonical type, and no edge is lossy", () => {
		const { edges } = mongoEngineDeclaration({ capture: true }).typeMapping;
		assert.deepEqual(
			edges.map((edge) => edge.canonical),
			[...CANONICAL_TYPES],
		);
		for (const edge of edges) {
			assert.notEqual(edge.write, "lossy", edge.canonical);
			assert.notEqual(edge.read, "lossy", edge.canonical);
		}
		const classes = Object.fromEntries(
			edges.map((edge) => [edge.canonical, `${edge.write}/${edge.read}`]),
		);
		assert.deepEqual(classes, {
			bool: "exact/exact",
			int64: "exact/exact",
			float64: "exact/widening",
			decimal: "constrained/widening",
			string: "constrained/exact",
			bytes: "exact/exact",
			timestamp: "exact/widening",
			date: "exact/widening",
			uuid: "exact/widening",
			json: "constrained/widening",
			encrypted: "constrained/exact",
		});
	});

	test("the impedance list is closed and free of duplicates", () => {
		assert.equal(
			new Set(MONGO_IMPEDANCE_CODES).size,
			MONGO_IMPEDANCE_CODES.length,
		);
		assert.deepEqual(
			[...mongoEngineDeclaration({ capture: true }).impedance],
			[...MONGO_IMPEDANCE_CODES],
		);
		assert.equal(HOBO_DATA_MONGODB_PACKAGE, "@hobo/data-mongodb");
	});
});

describe("options are parsed once", () => {
	test("defaults are filled in", () => {
		const executor = createMemoryMongoExecutor();
		const settings = parseMongoEngineOptions({ executor });
		assert.equal(settings.capture, true);
		assert.equal(settings.metadataCollection, MONGO_METADATA_COLLECTION);
		assert.match(settings.mintFenceToken(), /^fence:[0-9a-f-]{36}$/u);
		assert.notEqual(settings.mintFenceToken(), settings.mintFenceToken());
	});

	test("a metadata collection that could be a dataset name is refused", () => {
		const executor = createMemoryMongoExecutor();
		for (const metadataCollection of ["orders", "_Upper", "_", "_a.b", "_$x"]) {
			assert.throws(
				() => createMongoEngine({ executor, metadataCollection }),
				(cause) =>
					isMongoDataError(cause instanceof Error ? cause : null) &&
					cause instanceof MongoDataError &&
					cause.code === "MONGODB_INVALID_OPTIONS",
			);
		}
		assert.throws(() => createMongoEngine({ executor, scanPageSize: 0 }));
	});

	test("a wire request is parsed, not trusted", () => {
		assert.deepEqual(
			parseFindRequest({
				collection: "c",
				select: { kind: "range", after: { t: "a", k: "1" } },
				limit: 5,
			}),
			{
				collection: "c",
				select: { kind: "range", after: { t: "a", k: "1" } },
				limit: 5,
			},
		);
		for (const bad of [
			null,
			{ collection: "", select: { kind: "ids", ids: [] } },
			{ collection: "c", select: { kind: "regex" } },
			{ collection: "c", select: { kind: "ids", ids: [] }, limit: 0 },
		]) {
			assert.throws(
				() => parseFindRequest(bad),
				(cause) =>
					cause instanceof MongoDataError &&
					cause.code === "MONGODB_INVALID_REQUEST",
			);
		}
	});
});

describe("error mapping", () => {
	const table: readonly (readonly [number, MongoDataErrorCode])[] = [
		[MONGO_SERVER_CODES.documentValidationFailure, "MONGODB_DOCUMENT_REJECTED"],
		[MONGO_SERVER_CODES.bsonObjectTooLarge, "MONGODB_DOCUMENT_TOO_LARGE"],
		[MONGO_SERVER_CODES.illegalOperation, "MONGODB_TRANSACTIONS_UNAVAILABLE"],
		[
			MONGO_SERVER_CODES.operationNotSupportedInTransaction,
			"MONGODB_TRANSACTIONS_UNAVAILABLE",
		],
		[MONGO_SERVER_CODES.transactionTooLarge, "MONGODB_TRANSACTION_LIMIT"],
		[
			MONGO_SERVER_CODES.transactionExceededLifetimeLimit,
			"MONGODB_TRANSACTION_LIMIT",
		],
		[
			MONGO_SERVER_CODES.changeStreamNeedsReplicaSet,
			"MONGODB_CAPTURE_UNAVAILABLE",
		],
		[
			MONGO_SERVER_CODES.changeStreamHistoryLost,
			"MONGODB_CAPTURE_POSITION_LOST",
		],
		[
			MONGO_SERVER_CODES.changeStreamFatalError,
			"MONGODB_CAPTURE_POSITION_LOST",
		],
		[MONGO_SERVER_CODES.invalidResumeToken, "MONGODB_CAPTURE_POSITION_LOST"],
		[8000, "MONGODB_COMMAND_FAILED"],
	];

	test("every server code the binding understands maps to one stable code", () => {
		for (const [serverCode, expected] of table) {
			const failure = new MongoCommandError({
				code: serverCode,
				codeName: "Name",
			});
			const mapped = toMongoDataError(failure);
			assert.equal(mapped.code, expected);
			assert.ok(MONGO_DATA_ERROR_CODES.includes(mapped.code));
			assert.deepEqual(mapped.detail, { serverCode, codeName: "Name" });
			assert.equal(mapped.cause, failure);
		}
	});

	test("a server message never reaches a mapped error", () => {
		const connection = "mongodb://user:hunter2@db.internal:27017";
		const serverMessage = `E11000 duplicate key … { _id: { t: "tenant-a", k: "secret-key" } } at ${connection}`;
		const failure = new MongoCommandError(
			{ code: 121, codeName: "DocumentValidationFailure" },
			{ cause: new Error(serverMessage) },
		);
		const mapped = toMongoDataError(failure);
		for (const text of [
			failure.message,
			mapped.message,
			JSON.stringify(mapped.detail),
		]) {
			assert.ok(!text.includes("hunter2"));
			assert.ok(!text.includes("secret-key"));
		}
	});

	test("a command the executor refuses surfaces from the port as a MongoDataError", async () => {
		const inner = createMemoryMongoExecutor();
		let refuseWrites = false;
		const binding = await open({
			...inner,
			transaction: (body) =>
				inner.transaction((session) =>
					body({
						find: (request) => session.find(request),
						bulkWrite: (request) => {
							if (refuseWrites && request.collection === SCHEMA.name) {
								throw new MongoCommandError({
									code: MONGO_SERVER_CODES.documentValidationFailure,
									codeName: "DocumentValidationFailure",
								});
							}
							return session.bulkWrite(request);
						},
					}),
				),
		});
		refuseWrites = true;
		const error = await rejection(() =>
			binding.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("", "a")],
			}),
		);
		assert.ok(error instanceof MongoDataError);
		assert.equal(error.code, "MONGODB_DOCUMENT_REJECTED");
		assert.equal(await count(binding), 0);
	});

	test("a contract refusal stays a DataCoreError", async () => {
		const binding = await open();
		const absent = await rejection(() =>
			binding.records.write({
				dataset: "absent",
				mutations: [upsert("", "a")],
			}),
		);
		assert.ok(absent instanceof DataCoreError);
		const different = await rejection(async () => {
			await binding.datasets.ensureDataset(
				parseDatasetSchema({
					name: SCHEMA.name,
					keyFields: ["id"],
					fields: [{ name: "id", type: "string" }],
				}),
			);
		});
		assert.ok(
			different instanceof DataCoreError &&
				different.code === "INVALID_DATASET_SCHEMA",
		);
	});
});

describe("state lives in the store, not in the binding", () => {
	test("a second binding over the same store sees the dataset, the fence, the watermark, and the subscription", async () => {
		const executor = createMemoryMongoExecutor();
		const first = await open(executor);
		const scope = scopeOf(SCHEMA.name, "tenant-a");
		const grant = await requirePort(first, "fence").raise({
			scope,
			reason: "t",
		});
		const start = await requirePort(first, "capture").start({
			scope,
			subscription: "sub",
		});
		await requirePort(first, "apply").apply({
			dataset: SCHEMA.name,
			changes: [],
			source: "src",
			position: "41",
		});
		await first.records.write({
			dataset: SCHEMA.name,
			mutations: [upsert("tenant-b", "later")],
		});

		const second = createMongoEngine({ executor });
		assert.deepEqual(
			await second.datasets.describeDataset(SCHEMA.name),
			SCHEMA,
		);
		assert.deepEqual(await second.datasets.ensureDataset(SCHEMA), {
			dataset: SCHEMA.name,
			created: false,
		});
		assert.ok((await requirePort(second, "fence").status(scope)).fenced);
		assert.deepEqual(
			await requirePort(second, "fence").raise({ scope, reason: "again" }),
			grant,
		);
		assert.equal(
			await requirePort(second, "apply").watermark({
				dataset: SCHEMA.name,
				source: "src",
			}),
			"41",
		);
		// The original position, although a write has happened since.
		assert.equal(
			await requirePort(second, "capture").start({
				scope,
				subscription: "sub",
			}),
			start,
		);
		await requirePort(second, "capture").stop("sub");
		assert.notEqual(
			await requirePort(second, "capture").start({
				scope,
				subscription: "sub",
			}),
			start,
		);
	});
});

describe("writes are atomic", () => {
	test("a value the store cannot hold refuses the whole batch before anything is written", async () => {
		const binding = await open();
		const error = await rejection(() =>
			binding.records.write({
				dataset: SCHEMA.name,
				mutations: [
					upsert("", "fine"),
					upsert("", "too-precise", {
						price: "1234567890123456789012345678901234567890.123456789",
					}),
				],
			}),
		);
		assert.ok(error instanceof MongoDataError);
		assert.equal(error.code, "MONGODB_VALUE_NOT_REPRESENTABLE");
		assert.equal(await count(binding), 0);
	});

	test("a fenced tenant anywhere in a batch refuses all of it", async () => {
		const binding = await open();
		const fence = requirePort(binding, "fence");
		const grant = await fence.raise({
			scope: scopeOf(SCHEMA.name, "tenant-a"),
			reason: "t",
		});
		const error = await rejection(() =>
			binding.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("tenant-b", "ok"), upsert("tenant-a", "fenced")],
			}),
		);
		assert.ok(error instanceof FencedWriteError);
		assert.equal(error.tenant, "tenant-a");
		assert.equal(await count(binding), 0);
		// The same fence refuses the apply port and a delete, too.
		const applied = await rejection(() =>
			requirePort(binding, "apply").apply({
				dataset: SCHEMA.name,
				changes: [deleteMutation("tenant-a", keyOf("fenced"))],
				source: "s",
				position: "1",
			}),
		);
		assert.ok(applied instanceof FencedWriteError);
		assert.equal(
			await requirePort(binding, "apply").watermark({
				dataset: SCHEMA.name,
				source: "s",
			}),
			undefined,
			"a refused apply must not advance the watermark",
		);
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [upsert("tenant-a", "with-token")],
			fenceToken: grant.fenceToken,
		});
		assert.equal(await count(binding), 1);
	});

	test("a fence over the whole dataset refuses every tenant", async () => {
		const binding = await open();
		await requirePort(binding, "fence").raise({
			scope: scopeOf(SCHEMA.name),
			reason: "t",
		});
		for (const tenant of ["", "tenant-a"]) {
			const error = await rejection(() =>
				binding.records.write({
					dataset: SCHEMA.name,
					mutations: [upsert(tenant, "x")],
				}),
			);
			assert.ok(error instanceof FencedWriteError);
		}
	});

	test("raise waits out in-flight transactions before it returns", async () => {
		const inner = createMemoryMongoExecutor();
		const calls: string[] = [];
		const binding = await open({
			...inner,
			bulkWrite: (request) => {
				calls.push(`write:${request.collection}`);
				return inner.bulkWrite(request);
			},
			awaitTransactions: (request) => {
				calls.push(`await:${request.collection}`);
				return inner.awaitTransactions(request);
			},
		});
		calls.length = 0;
		await requirePort(binding, "fence").raise({
			scope: scopeOf(SCHEMA.name),
			reason: "t",
		});
		assert.deepEqual(calls, [
			`write:${MONGO_METADATA_COLLECTION}`,
			`await:${MONGO_METADATA_COLLECTION}`,
		]);
	});
});

describe("retire and capture edges", () => {
	test("retire is refused for the wrong token or a stale digest, and removes nothing", async () => {
		const binding = await open();
		const scope = scopeOf(SCHEMA.name, "tenant-a");
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [upsert("tenant-a", "1"), upsert("tenant-b", "2")],
		});
		const verify = requirePort(binding, "verify");
		const retire = requirePort(binding, "retire");
		const expected = await verify.digest({ scope, buckets: 8 });
		const grant = await requirePort(binding, "fence").raise({
			scope,
			reason: "t",
		});
		for (const request of [
			{ scope, fenceToken: "wrong", expected },
			{
				scope,
				fenceToken: grant.fenceToken,
				expected: await verify.digest({
					scope: scopeOf(SCHEMA.name),
					buckets: 8,
				}),
			},
		]) {
			const error = await rejection(() => retire.retire(request));
			assert.ok(
				error instanceof DataCoreError && error.code === "RETIRE_REFUSED",
			);
		}
		assert.equal(await count(binding), 2);
		assert.deepEqual(
			await retire.retire({ scope, fenceToken: grant.fenceToken, expected }),
			{ removed: 1 },
		);
		assert.equal(await count(binding), 1);
	});

	test("capture carries a native in-place update, and refuses an event that is not a record change", async () => {
		const inner = createMemoryMongoExecutor();
		let operation = "update";
		const binding = await open({
			...inner,
			readChanges: async (request) => {
				const batch = await inner.readChanges(request);
				return {
					...batch,
					events: batch.events.map((event) => ({ ...event, operation })),
				};
			},
		});
		const capture = requirePort(binding, "capture");
		const scope = scopeOf(SCHEMA.name);
		const start = await capture.start({ scope, subscription: "s" });
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [upsert("", "a", { qty: "5" })],
		});
		const read = { scope, subscription: "s", after: start, limit: 10 };
		const batch = await capture.read(read);
		assert.deepEqual(
			batch.changes.map((change) => [
				change.op,
				change.record?.qty,
				change.position,
			]),
			[["upsert", "5", batch.changes[0]?.position]],
		);
		operation = "drop";
		const error = await rejection(() => capture.read(read));
		assert.ok(error instanceof MongoDataError);
		assert.equal(error.code, "MONGODB_CAPTURE_UNSUPPORTED_EVENT");
		assert.equal(error.detail.operation, "drop");
	});

	test("a limit or chunk size below one is refused, not treated as empty", async () => {
		const binding = await open();
		const scope = scopeOf(SCHEMA.name);
		const capture = requirePort(binding, "capture");
		const start = await capture.start({ scope, subscription: "s" });
		for (const action of [
			() => capture.read({ scope, subscription: "s", after: start, limit: 0 }),
			() =>
				requirePort(binding, "snapshot").openSnapshot({ scope, chunkSize: 0 }),
		]) {
			const error = await rejection(async () => {
				await action();
			});
			assert.ok(
				error instanceof MongoDataError &&
					error.code === "MONGODB_INVALID_REQUEST",
			);
		}
	});
});
