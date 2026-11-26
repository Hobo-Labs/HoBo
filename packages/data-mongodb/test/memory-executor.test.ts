// The in-memory executor is only useful if it behaves like a server where a
// test would otherwise be fooled. These pin the behaviours that matter; the
// pact replay and the parity test in the live lane compare it with a real
// replica set.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	createMemoryMongoExecutor,
	MONGO_MAX_KEY,
	MONGO_MIN_KEY,
	type MongoBulkWriteResult,
	MongoCommandError,
	type MongoDocument,
	type MongoExecutor,
	type MongoValue,
	wrappedText,
} from "../src/index.js";

function id(tenant: string, key: string): MongoDocument {
	return { t: tenant, k: key };
}

async function put(
	executor: MongoExecutor,
	...documents: readonly MongoDocument[]
): Promise<void> {
	await executor.bulkWrite({
		collection: "c",
		operations: documents.map((document) => ({ kind: "replace", document })),
	});
}

async function all(executor: MongoExecutor): Promise<readonly MongoDocument[]> {
	const { documents } = await executor.find({
		collection: "c",
		select: { kind: "range" },
	});
	return documents;
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

async function codeOf(action: () => Promise<void>): Promise<number> {
	try {
		await action();
	} catch (cause) {
		assert.ok(cause instanceof MongoCommandError, String(cause));
		return cause.code;
	}
	return assert.fail("expected the command to be refused");
}

describe("in-memory executor: values", () => {
	test("values come back as a driver returns them, not as they were sent", async () => {
		const executor = createMemoryMongoExecutor();
		await put(executor, {
			_id: "v",
			small: { $numberDecimal: "0.0000001234" },
			big: { $numberDecimal: "1000000000000000000000000000000000000" },
			plain: { $numberDecimal: "1234.56" },
			double: { $numberDouble: "1" },
			bare: 7,
			fraction: 1.5,
			bytes: { $binary: { base64: "AAECA/8=", subType: "0" } },
		});
		assert.deepEqual(await all(executor), [
			{
				_id: "v",
				small: { $numberDecimal: "1.234E-7" },
				big: { $numberDecimal: "1.000000000000000000000000000000000E+36" },
				plain: { $numberDecimal: "1234.56" },
				double: { $numberDouble: "1.0" },
				bare: { $numberInt: "7" },
				fraction: { $numberDouble: "1.5" },
				bytes: { $binary: { base64: "AAECA/8=", subType: "00" } },
			},
		]);
	});

	test("an unpaired surrogate is stored as U+FFFD, exactly as UTF-8 would", async () => {
		const executor = createMemoryMongoExecutor();
		await put(executor, { _id: "s", text: "a\ud800b" });
		assert.deepEqual(await all(executor), [{ _id: "s", text: "a�b" }]);
	});

	test("a decimal that needs rounding and a NUL in a field name are refused", async () => {
		const executor = createMemoryMongoExecutor();
		assert.equal(
			await codeOf(() =>
				put(executor, {
					_id: "d",
					n: { $numberDecimal: "12345678901234567890123456789012345" },
				}),
			),
			2,
		);
		assert.equal(
			await codeOf(() => put(executor, { _id: "n", "a\u0000b": 1 })),
			2,
		);
	});
});

describe("in-memory executor: _id order and ranges", () => {
	test("_id order is BSON order: UTF-8 bytes, field by field", async () => {
		const executor = createMemoryMongoExecutor();
		const ids: MongoValue[] = [
			id("b", "1"),
			id("a", "\u{1F600}"),
			id("ab", "1"),
			id("a", "�"),
			id("", "9"),
			id("a", "2"),
			id("a", "1"),
		];
		await put(executor, ...ids.map((value) => ({ _id: value })));
		assert.deepEqual(
			(await all(executor)).map((document) => document._id),
			[
				id("", "9"),
				id("a", "1"),
				id("a", "2"),
				// U+FFFD (EF BF BD) sorts before U+1F600 (F0 9F 98 80) in UTF-8,
				// and after it in UTF-16 code units.
				id("a", "�"),
				id("a", "\u{1F600}"),
				id("ab", "1"),
				id("b", "1"),
			],
		);
		const tenant = await executor.find({
			collection: "c",
			select: {
				kind: "range",
				after: { t: "a", k: MONGO_MIN_KEY },
				before: { t: "a", k: MONGO_MAX_KEY },
			},
			limit: 3,
		});
		assert.deepEqual(
			tenant.documents.map((document) => document._id),
			[id("a", "1"), id("a", "2"), id("a", "�")],
		);
	});

	test("deleteRange removes exactly the range", async () => {
		const executor = createMemoryMongoExecutor();
		await put(
			executor,
			{ _id: id("a", "1") },
			{ _id: id("a", "2") },
			{ _id: id("b", "1") },
		);
		const result = await executor.bulkWrite({
			collection: "c",
			operations: [
				{
					kind: "deleteRange",
					after: { t: "a", k: MONGO_MIN_KEY },
					before: { t: "a", k: MONGO_MAX_KEY },
				},
			],
		});
		assert.equal(result.deleted, 2);
		assert.deepEqual(
			(await all(executor)).map((document) => document._id),
			[id("b", "1")],
		);
	});
});

describe("in-memory executor: validator", () => {
	const validator: MongoDocument = {
		$jsonSchema: {
			bsonType: "object",
			required: ["_id", "qty"],
			additionalProperties: false,
			properties: {
				_id: { bsonType: "string" },
				qty: { bsonType: "long" },
				at: { bsonType: ["string", "null"], pattern: "^[0-9]{4}$" },
			},
		},
	};

	test("a document of the wrong BSON type, layout, or with an extra field is refused with code 121", async () => {
		const executor = createMemoryMongoExecutor();
		await executor.ensureCollection({
			collection: "c",
			validator,
			changeImages: false,
		});
		await put(executor, { _id: "ok", qty: { $numberLong: "1" }, at: "2026" });
		await put(executor, { _id: "ok2", qty: { $numberLong: "1" }, at: null });
		for (const refused of [
			{ _id: "a", qty: { $numberInt: "1" } },
			{ _id: "b", qty: "1" },
			{ _id: "c" },
			{ _id: "d", qty: { $numberLong: "1" }, extra: true },
			{ _id: "e", qty: { $numberLong: "1" }, at: "20261" },
		]) {
			assert.equal(await codeOf(() => put(executor, refused)), 121);
		}
		assert.equal((await all(executor)).length, 2);
	});

	test("a validator keyword this executor does not implement is refused, never ignored", async () => {
		const executor = createMemoryMongoExecutor();
		await executor.ensureCollection({
			collection: "c",
			validator: { $jsonSchema: { minProperties: 1 } },
			changeImages: false,
		});
		assert.equal(await codeOf(() => put(executor, { _id: "x" })), 2);
	});

	test("ensureCollection converges an existing collection onto new options", async () => {
		const executor = createMemoryMongoExecutor();
		assert.deepEqual(
			await executor.ensureCollection({ collection: "c", changeImages: true }),
			{ created: true },
		);
		assert.deepEqual(
			await executor.ensureCollection({
				collection: "c",
				validator,
				changeImages: true,
			}),
			{ created: false },
		);
		assert.equal(await codeOf(() => put(executor, { _id: "x" })), 121);
	});
});

describe("in-memory executor: transactions and changes", () => {
	test("a transaction is all or nothing, for documents and for events", async () => {
		const executor = createMemoryMongoExecutor();
		const { token } = await executor.changeHead({ collection: "c" });
		await assert.rejects(
			executor.transaction(async (session) => {
				await session.bulkWrite({
					collection: "c",
					operations: [{ kind: "replace", document: { _id: "1" } }],
				});
				const inside = await session.find({
					collection: "c",
					select: { kind: "ids", ids: ["1"] },
				});
				assert.equal(
					inside.documents.length,
					1,
					"a session reads its own writes",
				);
				throw new Error("abort");
			}),
			/abort/u,
		);
		assert.deepEqual(await all(executor), []);
		const batch = await executor.readChanges({
			collection: "c",
			after: token,
			limit: 10,
		});
		assert.deepEqual(batch.events, []);
		assert.ok(batch.drained);
	});

	test("outside a transaction an ordered batch keeps what ran before the refusal", async () => {
		const executor = createMemoryMongoExecutor();
		assert.equal(
			await codeOf(async () => {
				await executor.bulkWrite({
					collection: "c",
					operations: [
						{ kind: "insert", document: { _id: "1" } },
						{ kind: "insert", document: { _id: "1" } },
						{ kind: "insert", document: { _id: "2" } },
					],
				});
			}),
			11000,
		);
		assert.deepEqual(await all(executor), [{ _id: "1" }]);
	});

	test("a write that changes nothing emits no event", async () => {
		const executor = createMemoryMongoExecutor();
		const { token } = await executor.changeHead({ collection: "c" });
		await put(executor, { _id: "1", n: { $numberLong: "1" } });
		await put(executor, { _id: "1", n: { $numberLong: "1" } });
		await executor.bulkWrite({
			collection: "c",
			operations: [{ kind: "delete", id: "absent" }],
		});
		const batch = await executor.readChanges({
			collection: "c",
			after: token,
			limit: 10,
		});
		assert.deepEqual(
			batch.events.map((event) => event.operation),
			["insert"],
		);
	});

	test("a read is repeatable, honours its limit, and its token resumes exactly", async () => {
		const executor = createMemoryMongoExecutor();
		await put(executor, { _id: "before" });
		const { token } = await executor.changeHead({ collection: "c" });
		await put(executor, { _id: "1" }, { _id: "2" }, { _id: "3" });
		await executor.bulkWrite({
			collection: "other",
			operations: [{ kind: "replace", document: { _id: "elsewhere" } }],
		});
		const first = await executor.readChanges({
			collection: "c",
			after: token,
			limit: 2,
		});
		assert.deepEqual(
			first.events.map((event) => event.id),
			["1", "2"],
		);
		assert.ok(!first.drained);
		assert.equal(first.token, first.events[1]?.token);
		const rest = await executor.readChanges({
			collection: "c",
			after: first.token,
			limit: 2,
		});
		assert.deepEqual(
			rest.events.map((event) => event.id),
			["3"],
		);
		assert.ok(rest.drained);
		// Drained means the whole log was considered, other collections too.
		assert.notEqual(rest.token, rest.events[0]?.token);
		const again = await executor.readChanges({
			collection: "c",
			after: token,
			limit: 10,
		});
		assert.equal(again.events.length, 3);
		assert.equal(
			await codeOf(async () => {
				await executor.readChanges({
					collection: "c",
					after: "nope",
					limit: 1,
				});
			}),
			260,
		);
	});
});

describe("in-memory executor: the 16 MiB document limit", () => {
	// { _id: "big", s: <n bytes> } is 26 + n bytes of BSON.
	const sized = (bytes: number): MongoDocument => ({
		_id: "big",
		s: "x".repeat(bytes - 26),
	});
	const limit = 16 * 1024 * 1024;

	test("a document one byte under 16 MiB is stored; at 16 MiB it is refused with code 10334", async () => {
		const executor = createMemoryMongoExecutor();
		await put(executor, sized(limit - 1));
		assert.equal(await codeOf(() => put(executor, sized(limit))), 10334);
		assert.equal(
			await codeOf(async () => {
				await executor.transaction((session) =>
					session.bulkWrite({
						collection: "c",
						operations: [{ kind: "insert", document: sized(limit + 1) }],
					}),
				);
			}),
			10334,
		);
		// Lengths only: a failure here must not print 16 MiB of text.
		const [stored] = await all(executor);
		assert.equal(
			String(stored?.s).length,
			limit - 1 - 26,
			"the stored document is still the smaller one",
		);
	});
});

describe("in-memory executor: transactions interleave", () => {
	const counter = (value: bigint): MongoDocument => ({
		_id: "counter",
		n: { $numberLong: String(value) },
	});

	test("a transaction reads the snapshot taken at its first statement", async () => {
		const executor = createMemoryMongoExecutor();
		await put(executor, { _id: "1" });
		const seen = await executor.transaction(async (session) => {
			const before = await session.find({
				collection: "c",
				select: { kind: "range" },
			});
			// Committed by someone else while this transaction is open.
			await put(executor, { _id: "2" });
			const after = await session.find({
				collection: "c",
				select: { kind: "range" },
			});
			return [before.documents.length, after.documents.length];
		});
		assert.deepEqual(seen, [1, 1]);
		assert.equal((await all(executor)).length, 2);
	});

	test("a commit takes a turn of the event loop, and the transaction is open until it lands", async () => {
		const executor = createMemoryMongoExecutor();
		const writing = executor.transaction((session) =>
			session.bulkWrite({
				collection: "c",
				operations: [{ kind: "insert", document: { _id: "1" } }],
			}),
		);
		// The body has returned. A reader that does not wait sees nothing yet…
		assert.deepEqual(await all(executor), []);
		// …and one that waits for the collection's transactions sees the commit.
		await executor.awaitTransactions({ collection: "c" });
		assert.equal((await all(executor)).length, 1);
		await writing;
	});

	test("awaitTransactions waits for an open transaction that touched the collection, and for no other", async () => {
		const executor = createMemoryMongoExecutor();
		const reached = deferred();
		const gate = deferred();
		const open = executor.transaction(async (session) => {
			// A read is enough to have touched it.
			await session.find({ collection: "c", select: { kind: "range" } });
			reached.resolve();
			await gate.promise;
			await session.bulkWrite({
				collection: "c",
				operations: [{ kind: "insert", document: { _id: "late" } }],
			});
		});
		await reached.promise;
		await executor.awaitTransactions({ collection: "elsewhere" });
		let waited = false;
		const waiting = executor.awaitTransactions({ collection: "c" }).then(() => {
			waited = true;
			return all(executor);
		});
		await settle();
		assert.equal(waited, false, "the transaction is still open");
		gate.resolve();
		assert.equal(
			(await waiting).length,
			1,
			"the wait ends only after the commit is visible",
		);
		await open;
	});

	test("a write to a document changed since the snapshot is a conflict: the body is rerun and no update is lost", async () => {
		const executor = createMemoryMongoExecutor();
		await put(executor, counter(0n));
		let runs = 0;
		const increment = (): Promise<void> =>
			executor.transaction(async (session) => {
				runs += 1;
				const { documents } = await session.find({
					collection: "c",
					select: { kind: "ids", ids: ["counter"] },
				});
				const current = BigInt(
					wrappedText(documents[0]?.n ?? null, "$numberLong") ?? "0",
				);
				await session.bulkWrite({
					collection: "c",
					operations: [{ kind: "replace", document: counter(current + 1n) }],
				});
			});
		await Promise.all([increment(), increment(), increment()]);
		assert.deepEqual(await all(executor), [counter(3n)]);
		assert.equal(runs, 6, "three bodies, and three reruns after a conflict");
	});

	test("a write outside a transaction waits for the transaction that holds its document", async () => {
		const executor = createMemoryMongoExecutor();
		const { token } = await executor.changeHead({ collection: "c" });
		const reached = deferred();
		const gate = deferred();
		const holder = executor.transaction(async (session) => {
			await session.bulkWrite({
				collection: "c",
				operations: [{ kind: "replace", document: counter(1n) }],
			});
			reached.resolve();
			await gate.promise;
		});
		await reached.promise;
		let landed = false;
		const outside = put(executor, counter(2n)).then(() => {
			landed = true;
		});
		await settle();
		assert.equal(landed, false);
		assert.deepEqual(await all(executor), []);
		gate.resolve();
		await Promise.all([holder, outside]);
		assert.deepEqual(await all(executor), [counter(2n)]);
		const { events } = await executor.readChanges({
			collection: "c",
			after: token,
			limit: 10,
		});
		assert.deepEqual(
			events.map((event) => event.operation),
			["insert", "replace"],
		);
	});

	test("the events of one transaction share an identity; a write outside one has none", async () => {
		const executor = createMemoryMongoExecutor();
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
		await put(executor, { _id: "outside" });
		await inTransaction("b1");
		const { events } = await executor.readChanges({
			collection: "c",
			after: token,
			limit: 10,
		});
		const [a1, a2, outside, b1] = events.map((event) => event.transaction);
		assert.ok(a1 !== undefined && a1 !== "");
		assert.equal(a2, a1);
		assert.equal(outside, undefined);
		assert.ok(b1 !== undefined && b1 !== a1);
	});

	test("a dropped collection is reported to every reader, whatever its key filter", async () => {
		const executor = createMemoryMongoExecutor();
		await put(executor, { _id: id("a", "1") }, { _id: id("b", "1") });
		const { token } = await executor.changeHead({ collection: "c" });
		await put(executor, { _id: id("b", "2") });
		await executor.dropCollection("c");
		const batch = await executor.readChanges({
			collection: "c",
			after: token,
			limit: 10,
			where: { path: "_id.t", equals: "a" },
		});
		assert.deepEqual(
			batch.events.map((event) => [event.operation, event.id]),
			[
				["drop", undefined],
				["invalidate", undefined],
			],
		);
		assert.deepEqual(await all(executor), []);
	});
});
