// The live lane: the same conformance kit, the same pact, and the behaviours
// only a real server can prove, against a MongoDB replica set through the
// reference driver adapter. Gated on HOBO_TEST_MONGODB_URL: a lane with no
// database skips it cleanly, and CI's `Live data engines` job sets it.
//
//   HOBO_TEST_MONGODB_URL='mongodb://127.0.0.1:57017/?replicaSet=rs0&directConnection=true' \
//     npx vitest run test/
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
	type CanonicalRecord,
	type CaptureBatch,
	canonicalEncode,
	DataCoreError,
	type DatasetSchema,
	ENGINE_CONFORMANCE_CASE_IDS,
	type EngineBinding,
	encodeRecordKey,
	FencedWriteError,
	type JsonObject,
	parseCanonicalRecord,
	parseDatasetSchema,
	type RecordMutation,
	referenceEngineHarness,
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
	type MongoBulkWriteResult,
	MongoCommandError,
	MongoDataError,
	type MongoDocument,
	type MongoExecutor,
} from "../src/index.js";
import { failures, NOW, tally } from "./support/harness.js";
import { connectLive, LIVE_URL, type LiveMongo } from "./support/live.js";
import { replayExecutorPact } from "./support/pact.js";

// Skipped, never passed: MongoDB declares no native migration profile and has
// no SQL surface, so it has neither a `nativeTransfer` nor a `schema` port.
const UNDECLARED_CASES = [
	"pattern.snapshot-and-tail.native.zero-loss-under-load",
	"pattern.snapshot-and-tail.native.resumes-at-every-boundary",
	"pattern.snapshot-and-tail.native.crash-windows.cutover",
	"pattern.in-place-evolve.gated-and-restorable",
	"pattern.in-place-evolve.failure-restores",
	"schema.snapshots-are-per-binding",
	"schema.multi-statement-entry-is-whole-or-refused",
	"schema.verify-refuses-a-trailing-statement",
];

// Run, and reported as a limit rather than a pass: MongoDB keeps no
// per-reader log, so an acknowledgement releases, records and checks nothing.
const DECLARED_LIMIT_CASE = "capture.acknowledged-positions-are-final";
const DECLARED_LIMIT = "MONGODB_CAPTURE_ACKNOWLEDGE_RELEASES_NOTHING";

const DOCUMENT_LIMIT = 16 * 1024 * 1024;

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

/** Fails when the error, however deep anyone looks, holds any of the texts. */
function assertCarriesNone(error: Error, texts: readonly string[]): void {
	const shown = inspect(error, {
		depth: Number.POSITIVE_INFINITY,
		showHidden: true,
	});
	for (const text of [...texts, "mongodb://", new URL(LIVE_URL).host]) {
		// Never interpolate `shown`: it is the thing that must not be printed.
		assert.ok(!shown.includes(text), "the error carries a value it must not");
	}
	assert.equal(error.cause, undefined, "a refusal is never chained");
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
			assert.deepEqual(report.skipped, UNDECLARED_CASES);
			assert.equal(
				report.results.length + report.skipped.length,
				ENGINE_CONFORMANCE_CASE_IDS.length,
			);
			// 44 cases run against the real server: 43 pass, and one is the
			// limit the declaration states.
			assert.deepEqual(
				report.results
					.filter((result) => result.status !== "pass")
					.map((result) => [result.caseId, result.status]),
				[[DECLARED_LIMIT_CASE, "declared-limit"]],
			);
			assert.match(
				report.results.find((result) => result.caseId === DECLARED_LIMIT_CASE)
					?.detail ?? "",
				new RegExp(`^${DECLARED_LIMIT}: `, "u"),
			);
		}, 300_000);

		test("MongoDB → reference engine: cross-engine through the hub", async () => {
			const report = await runEngineConformance({
				engine: live.harness(),
				peer: referenceEngineHarness(),
				now: NOW,
			});
			console.info(
				`live mongodb → reference: ${report.outcome} (${tally(report)})`,
			);
			assert.equal(report.outcome, "pass", failures(report));
		}, 300_000);

		test("reference engine → MongoDB: the other direction", async () => {
			const report = await runEngineConformance({
				engine: referenceEngineHarness(),
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

		test("both executors refuse a document at 16 MiB with code 10334 and store one a byte smaller", async () => {
			// { _id: "big", s: <n bytes> } is 26 + n bytes of BSON.
			const sized = (bytes: number): MongoDocument => ({
				_id: "big",
				s: "x".repeat(bytes - 26),
			});
			const server = live.executor(live.database(), true);
			try {
				for (const executor of [createMemoryMongoExecutor(), server]) {
					const attempt = async (
						kind: "insert" | "replace",
						bytes: number,
					): Promise<number> => {
						try {
							await executor.bulkWrite({
								collection: "c",
								operations: [{ kind, document: sized(bytes) }],
							});
							return 0;
						} catch (cause) {
							assert.ok(cause instanceof MongoCommandError, String(cause));
							return cause.code;
						}
					};
					assert.equal(await attempt("insert", DOCUMENT_LIMIT - 1), 0);
					assert.equal(await attempt("insert", DOCUMENT_LIMIT), 10334);
					assert.equal(await attempt("replace", DOCUMENT_LIMIT), 10334);
					assert.equal(await attempt("replace", DOCUMENT_LIMIT + 1), 10334);
					const { documents } = await executor.find({
						collection: "c",
						select: { kind: "range" },
					});
					// Lengths only: a failure must not print 16 MiB of text.
					assert.deepEqual(
						documents.map((document) => String(document.s).length),
						[DOCUMENT_LIMIT - 1 - 26],
					);
				}
			} finally {
				await server.close();
			}
		}, 120_000);

		test("both executors name the transaction on its events, and only on those", async () => {
			const server = live.executor(live.database(), true);
			try {
				for (const executor of [createMemoryMongoExecutor(), server]) {
					await executor.ensureCollection({
						collection: "c",
						changeImages: true,
					});
					const { token } = await executor.changeHead({ collection: "c" });
					const inTransaction = (
						...ids: readonly string[]
					): Promise<MongoBulkWriteResult> =>
						executor.transaction((session) =>
							session.bulkWrite({
								collection: "c",
								operations: ids.map((id) => ({
									kind: "insert",
									document: { _id: id },
								})),
							}),
						);
					await inTransaction("a1", "a2");
					await executor.bulkWrite({
						collection: "c",
						operations: [{ kind: "insert", document: { _id: "outside" } }],
					});
					await inTransaction("b1");
					const { events } = await executor.readChanges({
						collection: "c",
						after: token,
						limit: 10,
					});
					assert.deepEqual(
						events.map((event) => event.id),
						["a1", "a2", "outside", "b1"],
					);
					const [a1, a2, outside, b1] = events.map(
						(event) => event.transaction,
					);
					assert.ok(a1 !== undefined && a1 !== "");
					assert.equal(a2, a1);
					assert.equal(outside, undefined);
					assert.ok(b1 !== undefined && b1 !== a1);
				}
			} finally {
				await server.close();
			}
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
			// What the option made the server keep is the image *before* each
			// update. The post-images captured above are stored nowhere: the
			// server built them from these and each update's delta. That is why
			// the binding needs the option although it never reads a pre-image.
			const [info] = await live
				.native(database)
				.listCollections({ name: SCHEMA.name }, { nameOnly: false })
				.toArray();
			const images = await live.client
				.db("config")
				.collection("system.preimages")
				.find({ "_id.nsUUID": info?.info?.uuid })
				.sort({ "_id.ts": 1 })
				.toArray();
			assert.deepEqual(
				images.map((image) => String(image.preImage?.qty)),
				["1", "2"],
			);
		});

		test("with the change-image option turned off behind the binding, an in-place update is a failed read, never today's document", async () => {
			const { binding, database } = await open();
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(SCHEMA.name);
			await binding.records.write({
				dataset: SCHEMA.name,
				mutations: [upsert("", "a", { qty: "1" })],
			});
			const start = await capture.start({ scope, subscription: "no-images" });
			const native = live.native(database);
			await native.command({
				collMod: SCHEMA.name,
				changeStreamPreAndPostImages: { enabled: false },
			});
			await native
				.collection(SCHEMA.name)
				.updateOne({}, { $set: { qty: Long.fromString("2") } });
			const error = await rejection(async () => {
				await capture.read({
					scope,
					subscription: "no-images",
					after: start,
					limit: 10,
				});
			});
			assert.ok(error instanceof MongoDataError, String(error));
			assert.equal(error.code, "MONGODB_COMMAND_FAILED");
			// NoMatchingDocument: the stream requires a post-image and has none.
			assert.equal(error.detail.serverCode, 47);
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

		test("a dropped collection is a refused read, not an empty one — for a tenant-scoped reader too", async () => {
			const { binding, database } = await open();
			const capture = requirePort(binding, "capture");
			const start = await capture.start({
				scope: scopeOf(SCHEMA.name),
				subscription: "drop",
			});
			await live.native(database).collection(SCHEMA.name).drop();
			for (const tenant of ["", "tenant-a"]) {
				const error = await rejection(async () => {
					await capture.read({
						scope: scopeOf(SCHEMA.name, tenant),
						subscription: "drop",
						after: start,
						limit: 10,
					});
				});
				assert.ok(error instanceof MongoDataError, `tenant "${tenant}"`);
				assert.equal(error.code, "MONGODB_CAPTURE_UNSUPPORTED_EVENT");
				assert.equal(error.detail.operation, "drop");
			}
		});

		test("a position that is not a resume token is a lost position, whatever code the server gave it", async () => {
			const { binding, database } = await open();
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(SCHEMA.name);
			const start = await capture.start({ scope, subscription: "x" });
			const malformed = [
				"41",
				"0/16B3748",
				`82${"0".repeat(16)}`,
				start.slice(0, 6),
				start.slice(0, 22),
				"",
			];
			for (const after of malformed) {
				const error = await rejection(async () => {
					await capture.read({ scope, subscription: "x", after, limit: 1 });
				});
				assert.ok(error instanceof MongoDataError, `after "${after}"`);
				assert.equal(error.code, "MONGODB_CAPTURE_POSITION_LOST");
				assert.equal(error.detail.serverCode, 260);
			}
			// Why the adapter has to name it: asked directly, the server gives
			// these six tokens six different codes, and none of them is 260.
			const serverCodes = new Set<number>();
			for (const after of malformed) {
				const refusal = await rejection(async () => {
					await live.native(database).command({
						aggregate: SCHEMA.name,
						pipeline: [{ $changeStream: { resumeAfter: { _data: after } } }],
						cursor: { batchSize: 0 },
					});
				});
				serverCodes.add("code" in refusal ? Number(refusal.code) : -1);
			}
			assert.equal(serverCodes.size, malformed.length);
			assert.ok(!serverCodes.has(260) && !serverCodes.has(-1));
			// The stream itself is fine: the same reader, a real position.
			const batch = await capture.read({
				scope,
				subscription: "x",
				after: start,
				limit: 1,
			});
			assert.deepEqual(batch.changes, []);
		});

		test("capture.read never splits a source transaction, and may exceed its limit to keep one whole", async () => {
			const { binding } = await open();
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(SCHEMA.name);
			const start = await capture.start({ scope, subscription: "whole" });
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
					subscription: "whole",
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
			assert.deepEqual(ids(await read(start, 5)), [
				"a1",
				"a2",
				"a3",
				"a4",
				"a5",
			]);
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
				subscription: "whole-a",
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

		test("an envelope's position inside a transaction is resumable only under the scope that read it", async () => {
			const { binding } = await open();
			const capture = requirePort(binding, "capture");
			const start = await capture.start({
				scope: scopeOf(SCHEMA.name),
				subscription: "everyone",
			});
			await binding.records.write({
				dataset: SCHEMA.name,
				mutations: [
					upsert("tenant-a", "ours"),
					upsert("tenant-b", "theirs"),
					upsert("tenant-a", "ours-too"),
				],
			});
			const read = (tenant: string, after: string) =>
				capture.read({
					scope: scopeOf(SCHEMA.name, tenant),
					subscription: "everyone",
					after,
					limit: 10,
				});
			const batch = await read("", start);
			const inside = batch.changes[1]?.position ?? "";
			// `inside` is tenant-b's change, in the middle of the transaction.
			// A stream filtered to tenant-a never contains that event, so the
			// server has nowhere to resume from. Pinned so the limit is known
			// rather than discovered: a position belongs to the scope that read
			// it.
			const error = await rejection(async () => {
				await read("tenant-a", inside);
			});
			assert.ok(error instanceof MongoDataError, String(error));
			assert.equal(error.code, "MONGODB_CAPTURE_POSITION_LOST");
			assert.equal(error.detail.serverCode, 280);
			// Under the scope that produced it, the same position resumes.
			assert.deepEqual(
				(await read("", inside)).changes.map((change) => change.record?.id),
				["ours-too"],
			);
		});

		test("a subscription name belongs to one scope", async () => {
			const { binding } = await open();
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(SCHEMA.name);
			const start = await capture.start({ scope, subscription: "s1" });
			const error = await rejection(async () => {
				await capture.start({
					scope: scopeOf(SCHEMA.name, "tenant-a"),
					subscription: "s1",
				});
			});
			assert.ok(error instanceof MongoDataError, String(error));
			assert.equal(error.code, "MONGODB_CAPTURE_SUBSCRIPTION_CONFLICT");
			assert.equal(await capture.start({ scope, subscription: "s1" }), start);
		});
	});

	describe("retire", () => {
		test("a redelivered retire of a scope already retired succeeds and removes nothing; a wrong token is still refused", async () => {
			const { binding } = await open();
			const scope = scopeOf(SCHEMA.name, "tenant-a");
			await binding.records.write({
				dataset: SCHEMA.name,
				mutations: [
					upsert("tenant-a", "1"),
					upsert("tenant-a", "2"),
					upsert("tenant-b", "3"),
				],
			});
			const retire = requirePort(binding, "retire");
			const verify = requirePort(binding, "verify");
			const grant = await requirePort(binding, "fence").raise({
				scope,
				reason: "live",
			});
			const expected = await verify.digest({ scope, buckets: 4 });
			const request = { scope, fenceToken: grant.fenceToken, expected };
			assert.deepEqual(await retire.retire(request), { removed: 2 });
			assert.deepEqual(await retire.retire(request), { removed: 0 });
			const refused = await rejection(async () => {
				await retire.retire({ ...request, fenceToken: "not-the-token" });
			});
			assert.ok(
				refused instanceof DataCoreError && refused.code === "RETIRE_REFUSED",
				String(refused),
			);
			const rest = await verify.digest({
				scope: scopeOf(SCHEMA.name),
				buckets: 4,
			});
			assert.equal(rest.count, 1);
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
		test("a refused command carries the server's code and never its message, at any depth", async () => {
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
				assertCarriesNone(error, ["secret-key-value", "E11000"]);
			} finally {
				await executor.close();
			}
		});

		test("a document the validator refuses is MONGODB_DOCUMENT_REJECTED, and the error holds none of it", async () => {
			const { binding, database } = await open();
			// Tighten the validator behind the binding's back, so a record the
			// binding considers valid is refused by the server — whose message
			// quotes the whole failing document.
			await live.native(database).command({
				collMod: SCHEMA.name,
				validator: {
					$jsonSchema: {
						bsonType: "object",
						properties: { note: { bsonType: "string", maxLength: 3 } },
					},
				},
			});
			const sentinel = "PAYLOAD-SENTINEL-4111111111111111";
			const error = await rejection(async () => {
				await binding.records.write({
					dataset: SCHEMA.name,
					mutations: [
						upsert("tenant-a", "secret-key-value", { note: sentinel }),
					],
				});
			});
			assert.ok(error instanceof MongoDataError, String(error));
			assert.equal(error.code, "MONGODB_DOCUMENT_REJECTED");
			assert.equal(error.detail.serverCode, 121);
			assertCarriesNone(error, [sentinel, "SENTINEL", "secret-key-value"]);
		});

		test("a record of 16 MiB or more is MONGODB_DOCUMENT_TOO_LARGE, and the batch writes nothing", async () => {
			const { binding } = await open();
			const error = await rejection(async () => {
				await binding.records.write({
					dataset: SCHEMA.name,
					mutations: [
						upsert("", "fine"),
						upsert("", "huge", { note: "x".repeat(DOCUMENT_LIMIT) }),
					],
				});
			});
			assert.ok(error instanceof MongoDataError, String(error));
			assert.equal(error.code, "MONGODB_DOCUMENT_TOO_LARGE");
			assert.equal(error.detail.serverCode, 10334);
			const digest = await requirePort(binding, "verify").digest({
				scope: scopeOf(SCHEMA.name),
				buckets: 4,
			});
			assert.equal(digest.count, 0);
		}, 120_000);

		test("a contract refusal holds no value either", async () => {
			const { binding } = await open();
			const scope = scopeOf(SCHEMA.name, "tenant-a");
			const sentinel = "PAYLOAD-SENTINEL-4111111111111111";
			await requirePort(binding, "fence").raise({ scope, reason: "live" });
			const fenced = await rejection(async () => {
				await binding.records.write({
					dataset: SCHEMA.name,
					mutations: [
						upsert("tenant-a", "secret-key-value", { note: sentinel }),
					],
				});
			});
			assert.ok(fenced instanceof FencedWriteError);
			assertCarriesNone(fenced, [sentinel, "secret-key-value"]);
			const unrepresentable = await rejection(async () => {
				await binding.records.write({
					dataset: SCHEMA.name,
					mutations: [
						upsert("tenant-b", "secret-key-value", {
							note: sentinel,
							price: "41111111111111114111111111111111.4111",
						}),
					],
				});
			});
			assert.ok(unrepresentable instanceof MongoDataError);
			assertCarriesNone(unrepresentable, [
				sentinel,
				"secret-key-value",
				"4111111111111111",
			]);
		});
	});
});
