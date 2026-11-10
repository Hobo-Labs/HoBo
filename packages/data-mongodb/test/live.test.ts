// The live lane: the same conformance kit, the same pact, and the behaviours
// only a real server can prove, against a MongoDB replica set through the
// reference driver adapter. Gated on HOBO_TEST_MONGODB_URL, so CI without a
// database skips it cleanly.
//
//   HOBO_TEST_MONGODB_URL='mongodb://127.0.0.1:57017/?replicaSet=rs0&directConnection=true' \
//     npx vitest run test/
import assert from "node:assert/strict";
import {
	type CanonicalRecord,
	canonicalEncode,
	createReferenceEngine,
	type DatasetSchema,
	ENGINE_CONFORMANCE_CASE_IDS,
	type EngineBinding,
	encodeRecordKey,
	FencedWriteError,
	type JsonObject,
	parseCanonicalRecord,
	parseDatasetSchema,
	type RecordMutation,
	requirePort,
	runEngineConformance,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import { Long } from "mongodb";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
	createMemoryMongoExecutor,
	createMongoEngine,
	MONGO_MAX_KEY,
	MONGO_METADATA_COLLECTION,
	MONGO_MIN_KEY,
	MongoCommandError,
	MongoDataError,
	type MongoDocument,
	type MongoExecutor,
} from "../src/index.js";
import { failures, NOW, tally } from "./support/harness.js";
import { connectLive, LIVE_URL, type LiveMongo } from "./support/live.js";
import { replayExecutorPact } from "./support/pact.js";

const SCHEMA_CASES = [
	"pattern.in-place-evolve.gated-and-restorable",
	"pattern.in-place-evolve.failure-restores",
];

const SCHEMA: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string" },
		{ name: "qty", type: "int64" },
		{ name: "price", type: "decimal", nullable: true },
		{ name: "weight", type: "float64", nullable: true },
		{ name: "note", type: "string", nullable: true },
		{ name: "blob", type: "bytes", nullable: true },
		{ name: "placed_at", type: "timestamp", nullable: true },
		{ name: "due", type: "date", nullable: true },
		{ name: "ref", type: "uuid", nullable: true },
		{ name: "attrs", type: "json", nullable: true },
		{ name: "card", type: "encrypted", nullable: true },
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

async function rejection(action: () => Promise<void>): Promise<Error> {
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

interface OpenedBinding {
	readonly binding: EngineBinding;
	readonly database: string;
}

function deferred(): Deferred {
	let release = (): void => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, resolve: () => release() };
}

describe.skipIf(LIVE_URL === "")("MongoDB engine (live replica set)", () => {
	let live: LiveMongo;
	const opened: EngineBinding[] = [];

	/** A binding over its own database, with the dataset ensured. */
	async function open(): Promise<OpenedBinding> {
		const database = live.database();
		const binding = createMongoEngine({
			executor: live.executor(database, true),
		});
		opened.push(binding);
		await binding.datasets.ensureDataset(SCHEMA);
		return { binding, database };
	}

	beforeAll(async () => {
		live = await connectLive();
	});

	afterAll(async () => {
		for (const binding of opened) await binding.close();
		const leftovers = (await live?.leftovers()) ?? [];
		await live?.close();
		assert.deepEqual(leftovers, [], "every test database must be dropped");
	});

	describe("conformance", () => {
		test("MongoDB as engine and peer passes every case it declares ports for", async () => {
			const report = await runEngineConformance({
				engine: live.harness(),
				now: NOW,
			});
			console.info(
				`live mongodb → mongodb: ${report.outcome} (${tally(report)})`,
			);
			assert.equal(report.outcome, "pass", failures(report));
			assert.equal(report.engine, "mongodb");
			assert.deepEqual(report.skipped, SCHEMA_CASES);
			assert.equal(
				report.results.length + report.skipped.length,
				ENGINE_CONFORMANCE_CASE_IDS.length,
			);
		}, 300_000);

		test("MongoDB → reference engine: cross-engine through the hub", async () => {
			const report = await runEngineConformance({
				engine: live.harness(),
				peer: { create: () => createReferenceEngine() },
				now: NOW,
			});
			console.info(
				`live mongodb → reference: ${report.outcome} (${tally(report)})`,
			);
			assert.equal(report.outcome, "pass", failures(report));
		}, 300_000);

		test("reference engine → MongoDB: the other direction", async () => {
			const report = await runEngineConformance({
				engine: { create: () => createReferenceEngine() },
				peer: live.harness(),
				now: NOW,
			});
			console.info(
				`live reference → mongodb: ${report.outcome} (${tally(report)})`,
			);
			assert.equal(report.outcome, "pass", failures(report));
		}, 300_000);
	});

	describe("the executor boundary", () => {
		test("the driver adapter honours every pact interaction", async () => {
			const executor = live.executor(live.database(), true);
			try {
				assert.deepEqual(await replayExecutorPact(executor), []);
			} finally {
				await executor.close();
			}
		});

		test("the in-memory executor returns exactly what a server returns", async () => {
			const documents: readonly MongoDocument[] = [
				{ _id: { t: "b", k: "1" } },
				{ _id: { t: "a", k: "\u{1F600}" } },
				{ _id: { t: "ab", k: "1" } },
				{ _id: { t: "a", k: "�" } },
				{ _id: { t: "", k: "9" } },
				{ _id: { t: "a", k: "2" } },
				{
					_id: { t: "a", k: "1" },
					long: { $numberLong: "-9223372036854775808" },
					decimals: [
						{ $numberDecimal: "0.0000001234" },
						{ $numberDecimal: "1000000000000000000000000000000000E+3" },
						{ $numberDecimal: "1234567890123456789012345678901234" },
						{ $numberDecimal: "1.10" },
						{ $numberDecimal: "-0" },
						{ $numberDecimal: "0.000001" },
						{ $numberDecimal: "1E-6176" },
						{ $numberDecimal: "10E+6111" },
					],
					doubles: [
						{ $numberDouble: "1" },
						{ $numberDouble: "-0.0" },
						{ $numberDouble: "1.7976931348623157e+308" },
						{ $numberDouble: "5e-324" },
						{ $numberDouble: "1e+21" },
						{ $numberDouble: "NaN" },
					],
					bare: [7, 1.5, 4294967296],
					bytes: { $binary: { base64: "AAECA/8=", subType: "00" } },
					uuid: {
						$binary: { base64: "D4+tW9nLRp+hZXCGdyiVDg==", subType: "04" },
					},
					date: { $date: { $numberLong: "-62135596800000" } },
					surrogate: "a\ud800b",
					nul: "a\u0000b",
					nested: { "dotted.key": [null, true], "": "empty" },
				},
			];
			const tenantA = {
				collection: "c",
				select: {
					kind: "range",
					after: { t: "a", k: MONGO_MIN_KEY },
					before: { t: "a", k: MONGO_MAX_KEY },
				},
			} as const;
			const answers: string[] = [];
			const server = live.executor(live.database(), true);
			try {
				for (const executor of [createMemoryMongoExecutor(), server]) {
					await executor.bulkWrite({
						collection: "c",
						operations: documents.map((document) => ({
							kind: "replace",
							document,
						})),
					});
					const everything = await executor.find({
						collection: "c",
						select: { kind: "range" },
					});
					const tenant = await executor.find({ ...tenantA, limit: 3 });
					answers.push(
						JSON.stringify([everything.documents, tenant.documents]),
					);
				}
			} finally {
				await server.close();
			}
			assert.equal(answers[0], answers[1]);
		});
	});

	describe("values on a real server", () => {
		const extremes: readonly JsonObject[] = [
			{ qty: "9007199254740993" },
			{ qty: "-9223372036854775808" },
			{ qty: "9223372036854775807" },
			{ price: "1234567890123456789012345678901234" },
			{ price: "0.000000000000000000000000000001234" },
			{ price: "1000000000000000000000000000000000000" },
			{ price: "-0.5000" },
			{ weight: 1.7976931348623157e308 },
			{ weight: 5e-324 },
			{ weight: -0 },
			{ note: "NUL \u0000, astral \u{1F600}, ünïcödé" },
			{ blob: "" },
			{ blob: "AAECA/8=" },
			{ placed_at: "2026-01-02T03:04:05.678901Z" },
			{ placed_at: "9999-12-31T23:59:59.999999Z" },
			{ due: "0100-01-01" },
			{ due: "9999-12-31" },
			{ ref: "0f8fad5b-d9cb-469f-a165-70867728950e" },
			{
				attrs: {
					"dotted.key": [1, -0, 1.5, 1e300, null],
					"": { deep: [[[]]] },
				},
			},
			{ attrs: JSON.parse('{"__proto__":{"x":1},"b":2}') },
			{ attrs: "a bare string" },
			{
				card: {
					alg: "AES-256-GCM",
					keyRef: "key://s/1",
					ciphertext: "3q2+7w==",
				},
			},
		];

		test("every representable value reads back byte-identical in canonical form", async () => {
			const { binding } = await open();
			const mutations = extremes.map((fields, index) =>
				upsert("tenant-a", `extreme-${index}`, fields),
			);
			await binding.records.write({ dataset: SCHEMA.name, mutations });
			for (const mutation of mutations) {
				const read = await binding.records.read({
					dataset: SCHEMA.name,
					tenant: "tenant-a",
					key: mutation.key,
				});
				assert.equal(
					canonicalEncode(read ?? null),
					canonicalEncode(mutation.record ?? null),
				);
			}
		});

		test("a value the native type cannot hold is refused and nothing is written", async () => {
			const { binding } = await open();
			for (const fields of [
				{ price: "1234567890123456789012345678901234567890.123456789" },
				{ price: "12345678901234567890123456789012345" },
				{ attrs: { $where: "1" } },
			]) {
				const error = await rejection(async () => {
					await binding.records.write({
						dataset: SCHEMA.name,
						mutations: [upsert("", "ok"), upsert("", "refused", fields)],
					});
				});
				assert.ok(error instanceof MongoDataError);
				assert.equal(error.code, "MONGODB_VALUE_NOT_REPRESENTABLE");
			}
			const digest = await requirePort(binding, "verify").digest({
				scope: scopeOf(SCHEMA.name),
				buckets: 4,
			});
			assert.equal(digest.count, 0);
		});

		test("an unpaired surrogate never reaches the binding: the canonical model refuses it", () => {
			// The driver would store U+FFFD in its place. The refusal now lives
			// in @hobo/data-core, once, for every engine.
			assert.throws(
				() => upsert("", "refused", { note: "unpaired \ud800 surrogate" }),
				/unpaired surrogate/u,
			);
		});

		test("the validator stops a native writer storing the wrong BSON type", async () => {
			const { binding, database } = await open();
			await binding.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("", "a")],
			});
			const collection = live.native(database).collection(SCHEMA.name);
			await assert.rejects(
				collection.updateOne({}, { $set: { qty: "not a long" } }),
				(cause) =>
					cause instanceof Error && "code" in cause && cause.code === 121,
			);
			await assert.rejects(
				collection.updateOne({}, { $set: { undeclared: 1 } }),
				(cause) =>
					cause instanceof Error && "code" in cause && cause.code === 121,
			);
		});

		test("a native value with no canonical form is refused on read, never coerced", async () => {
			const { binding, database } = await open();
			const mutation = upsert("", "a", { weight: 1.5 });
			await binding.records.write({
				dataset: SCHEMA.name,
				mutations: [mutation],
			});
			// A double can be NaN and still satisfy the validator.
			await live
				.native(database)
				.collection(SCHEMA.name)
				.updateOne({}, { $set: { weight: Number.NaN } });
			const error = await rejection(async () => {
				await binding.records.read({
					dataset: SCHEMA.name,
					tenant: "",
					key: mutation.key,
				});
			});
			assert.ok(error instanceof MongoDataError);
			assert.equal(error.code, "MONGODB_NON_CANONICAL_VALUE");
			assert.equal(error.detail.field, "weight");
		});
	});

	describe("capture on a real change stream", () => {
		test("a native in-place update is captured as the document as of that change", async () => {
			const { binding, database } = await open();
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(SCHEMA.name);
			await binding.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("", "a", { qty: "1" })],
			});
			const start = await capture.start({ scope, subscription: "native" });
			const collection = live.native(database).collection(SCHEMA.name);
			// Two partial updates by a client with its own connection. Without
			// post-images the first could only be looked up as today's document.
			await collection.updateOne({}, { $set: { qty: Long.fromString("2") } });
			await collection.updateOne({}, { $set: { qty: Long.fromString("3") } });
			const batch = await capture.read({
				scope,
				subscription: "native",
				after: start,
				limit: 10,
			});
			assert.deepEqual(
				batch.changes.map((change) => `${change.op}:${change.record?.qty}`),
				["upsert:2", "upsert:3"],
			);
			assert.ok(batch.caughtUp);
		});

		test("a write that changes nothing produces no change", async () => {
			const { binding } = await open();
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(SCHEMA.name);
			const start = await capture.start({ scope, subscription: "noop" });
			const mutation = upsert("", "a");
			for (let round = 0; round < 3; round += 1) {
				await binding.records.write({
					dataset: SCHEMA.name,
					mutations: [mutation],
				});
			}
			const batch = await capture.read({
				scope,
				subscription: "noop",
				after: start,
				limit: 10,
			});
			assert.equal(batch.changes.length, 1);
		});

		test("a dropped collection is a refused read, not an empty one", async () => {
			const { binding, database } = await open();
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(SCHEMA.name);
			const start = await capture.start({ scope, subscription: "drop" });
			await live.native(database).collection(SCHEMA.name).drop();
			const error = await rejection(async () => {
				await capture.read({
					scope,
					subscription: "drop",
					after: start,
					limit: 10,
				});
			});
			assert.ok(error instanceof MongoDataError);
			assert.equal(error.code, "MONGODB_CAPTURE_UNSUPPORTED_EVENT");
		});

		test("a position that is not a resume token is refused", async () => {
			const { binding } = await open();
			const error = await rejection(async () => {
				await requirePort(binding, "capture").read({
					scope: scopeOf(SCHEMA.name),
					subscription: "x",
					after: "41",
					limit: 1,
				});
			});
			assert.ok(error instanceof MongoDataError, String(error));
		});
	});

	describe("the fence", () => {
		test("raise waits for a write that read 'not fenced' before the fence committed", async () => {
			const { binding, database } = await open();
			const reachedFenceCheck = deferred();
			const gate = deferred();
			const inner = live.executor(database, false);
			// A writer that stalls between its fence check and its write.
			const stalled: MongoExecutor = {
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
			};
			const writer = createMongoEngine({ executor: stalled });
			const scope = scopeOf(SCHEMA.name, "tenant-a");
			const fence = requirePort(binding, "fence");
			const verify = requirePort(binding, "verify");

			const straggler = Promise.resolve(
				writer.records.write({
					dataset: SCHEMA.name,
					mutations: [upsert("tenant-a", "straggler")],
				}),
			);
			await reachedFenceCheck.promise;
			let raised = false;
			const raising = Promise.resolve(
				fence.raise({ scope, reason: "live" }),
			).then((grant) => {
				raised = true;
				return grant;
			});
			await new Promise((resolve) => setTimeout(resolve, 400));
			assert.equal(
				raised,
				false,
				"raise must not return while an unfenced write is still in flight",
			);
			gate.resolve();
			await straggler;
			const grant = await raising;

			// The straggler landed before raise returned, so what the migration
			// digests under the fence is what stays there.
			const under = await verify.digest({ scope, buckets: 4 });
			assert.equal(under.count, 1);
			const late = await rejection(async () => {
				await writer.records.write({
					dataset: SCHEMA.name,
					mutations: [upsert("tenant-a", "late")],
				});
			});
			assert.ok(late instanceof FencedWriteError);
			await writer.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("tenant-a", "authorized")],
				fenceToken: grant.fenceToken,
			});
			assert.equal((await verify.digest({ scope, buckets: 4 })).count, 2);
		}, 60_000);

		test("the fence is entry-point only: a client with its own connection still writes", async () => {
			const { binding, database } = await open();
			const scope = scopeOf(SCHEMA.name);
			await binding.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("", "a")],
			});
			await requirePort(binding, "fence").raise({ scope, reason: "live" });
			// This is the declared limit, pinned so nobody mistakes it for a bug
			// or quietly claims `store` enforcement.
			const result = await live
				.native(database)
				.collection(SCHEMA.name)
				.updateOne({}, { $set: { note: "written around the fence" } });
			assert.equal(result.modifiedCount, 1);
			assert.equal(binding.declaration.fenceEnforcement, "entry-point");
		});
	});

	describe("errors", () => {
		test("a refused command carries the server's code and never its message", async () => {
			const executor = live.executor(live.database(), true);
			try {
				const document = { _id: { t: "tenant-a", k: "secret-key-value" } };
				const insert = {
					collection: "c",
					operations: [{ kind: "insert", document }],
				} as const;
				await executor.bulkWrite(insert);
				const error = await rejection(async () => {
					await executor.bulkWrite(insert);
				});
				assert.ok(error instanceof MongoCommandError);
				assert.equal(error.code, 11000);
				assert.ok(!error.message.includes("secret-key-value"));
				assert.ok(!error.message.includes("mongodb://"));
			} finally {
				await executor.close();
			}
		});
	});
});
