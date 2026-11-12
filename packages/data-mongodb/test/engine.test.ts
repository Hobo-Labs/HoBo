// The binding itself: what it declares, how it maps a refused command, and
// the behaviours the conformance kit does not reach — persistence across
// bindings, atomic refusal, and where the fence sits.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
	type Awaitable,
	assertBindingMatchesDeclaration,
	CANONICAL_TYPES,
	type CanonicalRecord,
	type CaptureBatch,
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

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let release = (): void => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, resolve: () => release() };
}

/** A turn of the timer queue: long enough for anything not waiting to finish. */
function settle(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 20);
	});
}

/** An executor whose named step refuses with a server code, once armed. */
interface Refusing {
	readonly executor: MongoExecutor;
	arm(code: number): void;
}

function refusing(): Refusing {
	const inner = createMemoryMongoExecutor();
	let armed: number | undefined;
	const refuse = (): void => {
		if (armed !== undefined) {
			throw new MongoCommandError({ code: armed, codeName: "Name" });
		}
	};
	return {
		arm(code) {
			armed = code;
		},
		executor: {
			...inner,
			transaction: (body) =>
				inner.transaction((session) =>
					body({
						find: (request) => session.find(request),
						bulkWrite: async (request) => {
							if (request.collection === SCHEMA.name) refuse();
							return session.bulkWrite(request);
						},
					}),
				),
			changeHead: async (request) => {
				refuse();
				return inner.changeHead(request);
			},
			readChanges: async (request) => {
				refuse();
				return inner.readChanges(request);
			},
		},
	};
}

/** What must never appear in an error, however deep anyone looks. */
const LEAKS = ["hunter2", "db.internal", "secret-key", "E11000", "4111"];

function assertCarriesNothing(error: Error): void {
	const text = inspect(error, {
		depth: Number.POSITIVE_INFINITY,
		showHidden: true,
	});
	for (const leak of LEAKS) {
		assert.ok(!text.includes(leak), `the error carries ${leak}`);
	}
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
			assert.equal(mapped.cause, undefined, "a refusal is never chained");
		}
	});

	test("a refusal keeps a code, a name, and labels — never a message, never a cause", () => {
		const connection = "mongodb://user:hunter2@db.internal:27017";
		const serverMessage = `E11000 duplicate key … { _id: { t: "tenant-a", k: "secret-key" } } at ${connection}`;
		// Whatever an executor puts where a name belongs, only a name survives.
		const failure = new MongoCommandError({
			code: 121,
			codeName: serverMessage,
			labels: ["TransientTransactionError", serverMessage],
		});
		assert.equal(failure.codeName, "");
		assert.deepEqual(failure.labels, ["TransientTransactionError"]);
		assert.equal(failure.cause, undefined);
		assertCarriesNothing(failure);
		const mapped = toMongoDataError(failure);
		assert.deepEqual(mapped.detail, { serverCode: 121, codeName: "" });
		assertCarriesNothing(mapped);
	});

	test("no error from the binding carries what the executor's refusal was holding", async () => {
		const serverMessage =
			'Document failed validation: { _id: { t: "tenant-a", k: "secret-key" }, card: "4111111111111111" } on mongodb://user:hunter2@db.internal:27017';
		const inner = createMemoryMongoExecutor();
		let refuse = false;
		const binding = await open({
			...inner,
			transaction: (body) =>
				inner.transaction((session) =>
					body({
						find: (request) => session.find(request),
						bulkWrite: async (request) => {
							if (refuse && request.collection === SCHEMA.name) {
								// A careless executor: the driver's error hung on
								// the refusal, the way an adapter might chain it.
								throw Object.assign(
									new MongoCommandError({
										code: MONGO_SERVER_CODES.documentValidationFailure,
										codeName: "DocumentValidationFailure",
									}),
									{
										cause: new Error(serverMessage),
										errInfo: { failingDocument: serverMessage },
									},
								);
							}
							return session.bulkWrite(request);
						},
					}),
				),
		});
		refuse = true;
		const error = await rejection(() =>
			binding.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("", "a", { note: "4111111111111111" })],
			}),
		);
		assert.ok(error instanceof MongoDataError);
		assert.equal(error.code, "MONGODB_DOCUMENT_REJECTED");
		assert.equal(error.cause, undefined);
		assert.deepEqual(error.detail, {
			serverCode: 121,
			codeName: "DocumentValidationFailure",
		});
		assertCarriesNothing(error);
	});

	test("a refusal names no value: not the record, not the key, not the tenant's data", async () => {
		const binding = await open();
		const secret = "4111111111111111";
		for (const action of [
			// Not representable: 35 significant digits.
			() =>
				binding.records.write({
					dataset: SCHEMA.name,
					mutations: [
						upsert("", "secret-key", {
							price: `${secret}${secret}.123`,
							note: secret,
						}),
					],
				}),
			// A key that is not its record's key.
			() =>
				binding.records.write({
					dataset: SCHEMA.name,
					mutations: [
						upsertMutation(
							"",
							keyOf("secret-key"),
							parseCanonicalRecord(SCHEMA, { id: secret, qty: "1" }),
						),
					],
				}),
		]) {
			const error = await rejection(async () => {
				await action();
			});
			assertCarriesNothing(error);
		}
		assert.equal(await count(binding), 0);
	});

	// Every row of the README's error-code table, produced through a port.
	// These need a server condition the in-memory executor does not model, so
	// the executor reports the server's code and the port answers.
	const writeRefusals: readonly (readonly [number, MongoDataErrorCode])[] = [
		[MONGO_SERVER_CODES.documentValidationFailure, "MONGODB_DOCUMENT_REJECTED"],
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
		[8000, "MONGODB_COMMAND_FAILED"],
	];

	test("a write the server refuses surfaces from the port under its documented code, and writes nothing", async () => {
		for (const [serverCode, expected] of writeRefusals) {
			const { executor, arm } = refusing();
			const binding = await open(executor);
			arm(serverCode);
			const error = await rejection(() =>
				binding.records.write({
					dataset: SCHEMA.name,
					mutations: [upsert("", "a"), upsert("", "b")],
				}),
			);
			assert.ok(error instanceof MongoDataError, String(serverCode));
			assert.equal(error.code, expected);
			assert.equal(error.detail.serverCode, serverCode);
			assert.equal(await count(binding), 0);
		}
	});

	test("a stream the server refuses surfaces from the capture port under its documented code", async () => {
		const scope = scopeOf(SCHEMA.name);
		const { executor, arm } = refusing();
		const capture = requirePort(await open(executor), "capture");
		const start = await capture.start({ scope, subscription: "s" });
		arm(MONGO_SERVER_CODES.changeStreamNeedsReplicaSet);
		const unavailable = await rejection(() =>
			capture.start({ scope, subscription: "another" }),
		);
		assert.ok(unavailable instanceof MongoDataError);
		assert.equal(unavailable.code, "MONGODB_CAPTURE_UNAVAILABLE");
		for (const serverCode of [
			MONGO_SERVER_CODES.changeStreamHistoryLost,
			MONGO_SERVER_CODES.changeStreamFatalError,
			MONGO_SERVER_CODES.invalidResumeToken,
		]) {
			arm(serverCode);
			const lost = await rejection(() =>
				capture.read({ scope, subscription: "s", after: start, limit: 1 }),
			);
			assert.ok(lost instanceof MongoDataError);
			assert.equal(lost.code, "MONGODB_CAPTURE_POSITION_LOST");
			assert.equal(lost.detail.serverCode, serverCode);
		}
	});

	test("a record of 16 MiB or more is refused as too large, and the batch writes nothing", async () => {
		const binding = await open();
		const error = await rejection(() =>
			binding.records.write({
				dataset: SCHEMA.name,
				mutations: [
					upsert("", "fine"),
					upsert("", "huge", { note: "x".repeat(16 * 1024 * 1024) }),
				],
			}),
		);
		assert.ok(error instanceof MongoDataError, String(error));
		assert.equal(error.code, "MONGODB_DOCUMENT_TOO_LARGE");
		assert.equal(error.detail.serverCode, 10334);
		assert.equal(await count(binding), 0);
	});

	test("a position that is not a resume token is a lost position, not an empty batch", async () => {
		const binding = await open();
		const error = await rejection(() =>
			requirePort(binding, "capture").read({
				scope: scopeOf(SCHEMA.name),
				subscription: "s",
				after: "0/16B3748",
				limit: 1,
			}),
		);
		assert.ok(error instanceof MongoDataError);
		assert.equal(error.code, "MONGODB_CAPTURE_POSITION_LOST");
		assert.equal(error.detail.serverCode, 260);
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

	test("raise does not return while a writer that read 'not fenced' is still in flight", async () => {
		const inner = createMemoryMongoExecutor();
		const binding = await open(inner);
		const reachedFenceCheck = deferred();
		const gate = deferred();
		// A writer that stalls between its fence check and its write.
		const writer = createMongoEngine({
			executor: {
				...inner,
				transaction: (body) =>
					inner.transaction((session) =>
						body({
							find: async (request) => {
								const result = await session.find(request);
								if (request.collection === MONGO_METADATA_COLLECTION) {
									reachedFenceCheck.resolve();
									await gate.promise;
								}
								return result;
							},
							bulkWrite: (request) => session.bulkWrite(request),
						}),
					),
			},
		});
		const scope = scopeOf(SCHEMA.name, "tenant-a");
		const straggler = Promise.resolve(
			writer.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("tenant-a", "straggler")],
			}),
		);
		await reachedFenceCheck.promise;
		let raised = false;
		const raising = Promise.resolve(
			requirePort(binding, "fence").raise({ scope, reason: "t" }),
		).then((grant) => {
			raised = true;
			return grant;
		});
		await settle();
		assert.equal(
			raised,
			false,
			"raise must not return while an unfenced write is still in flight",
		);
		gate.resolve();
		await straggler;
		await raising;
		// The straggler landed before raise returned: what is digested under
		// the fence is what stays there.
		assert.equal(await count(binding, "tenant-a"), 1);
		const late = await rejection(() =>
			writer.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("tenant-a", "late")],
			}),
		);
		assert.ok(late instanceof FencedWriteError);
		assert.equal(await count(binding, "tenant-a"), 1);
	});

	test("two applies racing for one watermark both commit whole: the loser's body is rerun", async () => {
		const inner = createMemoryMongoExecutor();
		let bodies = 0;
		const binding = await open({
			...inner,
			transaction: (body) =>
				inner.transaction((session) => {
					bodies += 1;
					return body(session);
				}),
		});
		const apply = requirePort(binding, "apply");
		const batch = (id: string, position: string) =>
			apply.apply({
				dataset: SCHEMA.name,
				changes: [upsert("", id)],
				source: "src",
				position,
			});
		bodies = 0;
		await Promise.all([batch("a", "1"), batch("b", "2")]);
		assert.equal(await count(binding), 2);
		assert.equal(
			await apply.watermark({ dataset: SCHEMA.name, source: "src" }),
			"2",
			"the watermark is the one committed last",
		);
		assert.equal(bodies, 3, "the transaction that lost the conflict ran twice");
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

	test("a redelivered retire of a scope already retired succeeds and removes nothing; every other refusal stands", async () => {
		const binding = await open();
		const scope = scopeOf(SCHEMA.name, "tenant-a");
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [
				upsert("tenant-a", "1"),
				upsert("tenant-a", "2"),
				upsert("tenant-b", "3"),
			],
		});
		const fence = requirePort(binding, "fence");
		const retire = requirePort(binding, "retire");
		const grant = await fence.raise({ scope, reason: "t" });
		const expected = await requirePort(binding, "verify").digest({
			scope,
			buckets: 8,
		});
		const request = { scope, fenceToken: grant.fenceToken, expected };
		assert.deepEqual(await retire.retire(request), { removed: 2 });
		// The crash this is for: retire committed, the caller never heard.
		assert.deepEqual(await retire.retire(request), { removed: 0 });
		assert.deepEqual(await retire.retire(request), { removed: 0 });
		assert.equal(await count(binding), 1, "the other tenant is untouched");

		const refused = async (fenceToken: string): Promise<void> => {
			const error = await rejection(() =>
				retire.retire({ scope, fenceToken, expected }),
			);
			assert.ok(
				error instanceof DataCoreError && error.code === "RETIRE_REFUSED",
				String(error),
			);
		};
		// An empty scope is not a licence: the token still has to be the fence's.
		await refused("not-the-token");
		// A scope that is not empty and not what was proven is still refused.
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [upsert("tenant-a", "written-back")],
			fenceToken: grant.fenceToken,
		});
		await refused(grant.fenceToken);
		assert.equal(await count(binding, "tenant-a"), 1);
		// And with the fence down, so is an empty one.
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [deleteMutation("tenant-a", keyOf("written-back"))],
			fenceToken: grant.fenceToken,
		});
		await fence.release({ scope, fenceToken: grant.fenceToken });
		await refused(grant.fenceToken);
	});

	test("capture.read never splits a source transaction, and may exceed its limit to keep one whole", async () => {
		const binding = await open();
		const capture = requirePort(binding, "capture");
		const scope = scopeOf(SCHEMA.name);
		const start = await capture.start({ scope, subscription: "s" });
		const write = (tenant: string, ...ids: readonly string[]) =>
			binding.records.write({
				dataset: SCHEMA.name,
				mutations: ids.map((id) => upsert(tenant, id)),
			});
		const ids = (batch: CaptureBatch) =>
			batch.changes.map((change) => change.record?.id);
		const read = (after: string, limit: number, tenant = "") =>
			capture.read({
				scope: scopeOf(SCHEMA.name, tenant),
				subscription: "s",
				after,
				limit,
			});
		await write("", "a1", "a2", "a3", "a4", "a5");
		await write("", "b1");
		await write("", "c1", "c2");

		const first = await read(start, 2);
		assert.deepEqual(ids(first), ["a1", "a2", "a3", "a4", "a5"]);
		assert.equal(first.caughtUp, false);
		assert.equal(first.position, first.changes[4]?.position);
		const second = await read(first.position, 1);
		assert.deepEqual(ids(second), ["b1"]);
		assert.equal(second.caughtUp, false);
		const third = await read(second.position, 1);
		assert.deepEqual(ids(third), ["c1", "c2"]);
		assert.ok(third.caughtUp);
		// A limit that lands exactly on a boundary cuts there.
		assert.deepEqual(ids(await read(start, 5)), ["a1", "a2", "a3", "a4", "a5"]);
		assert.deepEqual(ids(await read(start, 6)), [
			"a1",
			"a2",
			"a3",
			"a4",
			"a5",
			"b1",
		]);

		// A tenant-scoped reader gets its part of a transaction, whole. It
		// reads from its own position: a position belongs to the scope that
		// produced it.
		const tenantScope = scopeOf(SCHEMA.name, "tenant-a");
		const tenantStart = await capture.start({
			scope: tenantScope,
			subscription: "t",
		});
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [
				upsert("tenant-a", "t1"),
				upsert("tenant-b", "t2"),
				upsert("tenant-a", "t3"),
				upsert("tenant-b", "t4"),
				upsert("tenant-a", "t5"),
			],
		});
		await write("tenant-a", "u1");
		const scoped = await read(tenantStart, 1, "tenant-a");
		assert.deepEqual(ids(scoped), ["t1", "t3", "t5"]);
		assert.equal(scoped.caughtUp, false);
		assert.deepEqual(ids(await read(scoped.position, 1, "tenant-a")), ["u1"]);
	});

	test("a subscription name belongs to one scope", async () => {
		const binding = await open();
		const other = parseDatasetSchema({
			name: "invoices",
			keyFields: ["id"],
			fields: [{ name: "id", type: "string" }],
		});
		await binding.datasets.ensureDataset(other);
		const capture = requirePort(binding, "capture");
		const scope = scopeOf(SCHEMA.name);
		const start = await capture.start({ scope, subscription: "s1" });
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [upsert("", "later")],
		});
		for (const elsewhere of [
			scopeOf(other.name),
			scopeOf(other.name, "tenant-z"),
			scopeOf(SCHEMA.name, "tenant-a"),
		]) {
			const error = await rejection(() =>
				capture.start({ scope: elsewhere, subscription: "s1" }),
			);
			assert.ok(error instanceof MongoDataError, String(error));
			assert.equal(error.code, "MONGODB_CAPTURE_SUBSCRIPTION_CONFLICT");
		}
		// The same scope still gets its original position…
		assert.equal(await capture.start({ scope, subscription: "s1" }), start);
		// …and once stopped, the name is free for another scope.
		await capture.stop("s1");
		assert.notEqual(
			await capture.start({ scope: scopeOf(other.name), subscription: "s1" }),
			start,
		);
	});

	test("a dropped collection refuses every reader, tenant-scoped ones included", async () => {
		const executor = createMemoryMongoExecutor();
		const binding = await open(executor);
		const capture = requirePort(binding, "capture");
		const start = await capture.start({
			scope: scopeOf(SCHEMA.name),
			subscription: "s",
		});
		await binding.records.write({
			dataset: SCHEMA.name,
			mutations: [upsert("tenant-b", "someone-else")],
		});
		await executor.dropCollection(SCHEMA.name);
		for (const tenant of ["", "tenant-a", "tenant-b"]) {
			const error = await rejection(() =>
				capture.read({
					scope: scopeOf(SCHEMA.name, tenant),
					subscription: "s",
					after: start,
					limit: 10,
				}),
			);
			assert.ok(error instanceof MongoDataError, `tenant "${tenant}"`);
			assert.equal(error.code, "MONGODB_CAPTURE_UNSUPPORTED_EVENT");
			assert.equal(error.detail.operation, "drop");
		}
	});

	test("a read the stream could not finish is not caught up, even with nothing to return", async () => {
		const inner = createMemoryMongoExecutor();
		const ahead = "820000000000000063";
		const binding = await open({
			...inner,
			readChanges: async () => ({ events: [], token: ahead, drained: false }),
		});
		const capture = requirePort(binding, "capture");
		const scope = scopeOf(SCHEMA.name);
		const start = await capture.start({ scope, subscription: "s" });
		assert.deepEqual(
			await capture.read({ scope, subscription: "s", after: start, limit: 5 }),
			{ changes: [], position: ahead, caughtUp: false },
		);
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
