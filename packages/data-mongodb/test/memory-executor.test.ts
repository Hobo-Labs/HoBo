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
	MongoCommandError,
	type MongoDocument,
	type MongoExecutor,
	type MongoValue,
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
