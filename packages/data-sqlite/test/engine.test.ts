// The SQLite binding's own guarantees, each against a real store file: what a
// dataset may be named, what the write entry point accepts, what a capture
// position means, how long the journal keeps a payload, and what a fence
// token is.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type DatasetSchema,
	deleteMutation,
	encodeRecordKey,
	isJsonObject,
	type JsonObject,
	parseCanonicalRecord,
	parseDatasetSchema,
	parseJsonText,
	type RecordMutation,
	requirePort,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import { afterEach, describe, test } from "vitest";
import { createSqliteEngine, type SqliteEngine } from "../src/index.js";
import { NOW, tempDir } from "./support.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const ORDERS = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string" },
		{ name: "email", type: "string", nullable: true },
	],
	open: true,
});

// The shared refusal from `@hobo/data-core`, not a package-local copy.
const POSITION_REFUSED = {
	name: "CapturePositionError",
	code: "CAPTURE_POSITION_INVALID",
};

function storePath(): string {
	const { dir, remove } = tempDir("hobo-sqlite-engine-");
	cleanups.push(remove);
	return path.join(dir, "store.db");
}

interface Opened {
	readonly engine: SqliteEngine;
	readonly file: string;
	/** Close the store now; the cleanup after the test then does nothing. */
	close(): void;
}

async function open(
	file = storePath(),
	schema: DatasetSchema = ORDERS,
): Promise<Opened> {
	const engine = createSqliteEngine({ path: file, clock: () => NOW });
	let closed = false;
	const close = () => {
		if (!closed) engine.close();
		closed = true;
	};
	cleanups.push(close);
	await engine.datasets.ensureDataset(schema);
	return { engine, file, close };
}

function put(
	tenant: string,
	fields: JsonObject,
	schema: DatasetSchema = ORDERS,
): RecordMutation {
	const record = parseCanonicalRecord(schema, fields);
	return upsertMutation(tenant, encodeRecordKey(schema, record), record);
}

function keyOf(id: string): string {
	return encodeRecordKey(ORDERS, parseCanonicalRecord(ORDERS, { id }));
}

interface JournalRow {
	readonly seq: number;
	readonly tenant_id: string;
	readonly op: string;
	readonly record: string | null;
}

/** The journal as a second connection to the file sees it. */
function journal(file: string): JournalRow[] {
	const db = new DatabaseSync(file);
	try {
		return db
			.prepare(
				"SELECT seq, tenant_id, op, record FROM hobo_data_journal ORDER BY seq",
			)
			.all()
			.map((row) => ({
				seq: Number(row.seq),
				tenant_id: String(row.tenant_id),
				op: String(row.op),
				record: row.record === null ? null : String(row.record),
			}));
	} finally {
		db.close();
	}
}

describe("dataset names", () => {
	test("a dataset may not take the name of a metadata table or a SQLite table", async () => {
		const { engine } = await open();
		for (const name of [
			"hobo_data_fences",
			"hobo_data_journal",
			"hobo_data_subscriptions",
			"hobo_data_anything_later",
			"sqlite_sequence",
		]) {
			const reserved = parseDatasetSchema({
				name,
				keyFields: ["dataset"],
				fields: [
					{ name: "dataset", type: "string" },
					{ name: "fence_token", type: "string", nullable: true },
				],
				open: true,
			});
			await assert.rejects(
				async () => {
					await engine.datasets.ensureDataset(reserved);
				},
				{ code: "INVALID_DATASET_SCHEMA" },
				name,
			);
			assert.equal(await engine.datasets.describeDataset(name), undefined);
		}
	});

	test("a reserved name registered by an earlier version is not served", async () => {
		const { engine, file } = await open();
		await requirePort(engine, "fence").raise({
			scope: scopeOf("orders", "acme"),
			reason: "move",
		});
		// What the store looked like once the fence table had been adopted as
		// a dataset: its schema row is all that made it readable.
		const poisoned = new DatabaseSync(file);
		poisoned
			.prepare("INSERT INTO hobo_data_datasets (name, schema) VALUES (?, ?)")
			.run(
				"hobo_data_fences",
				JSON.stringify({
					name: "hobo_data_fences",
					keyFields: ["dataset"],
					fields: [
						{ name: "dataset", type: "string" },
						{ name: "fence_token", type: "string" },
					],
					open: true,
				}),
			);
		poisoned.close();
		await assert.rejects(
			async () => {
				await engine.records.read({
					dataset: "hobo_data_fences",
					tenant: "acme",
					key: JSON.stringify(["orders"]),
				});
			},
			{ code: "INVALID_DATASET_SCHEMA" },
		);
	});
});

describe("the write entry point", () => {
	test("an undeclared field named __proto__ survives write, read and capture", async () => {
		const { engine } = await open();
		const capture = requirePort(engine, "capture");
		const scope = scopeOf("orders");
		const start = await capture.start({ scope, subscription: "sub_proto" });
		// Parsed, not written as a literal: a literal `__proto__` key sets the
		// prototype, where JSON.parse makes it an ordinary field.
		const fields = parseJsonText(
			'{"id":"order-1","__proto__":{"polluted":true}}',
		);
		assert.ok(isJsonObject(fields));
		const mutation = put("", fields);
		await engine.records.write({ dataset: "orders", mutations: [mutation] });
		const stored = await engine.records.read({
			dataset: "orders",
			tenant: "",
			key: mutation.key,
		});
		assert.ok(stored);
		assert.deepEqual(Object.keys(stored).sort(), ["__proto__", "email", "id"]);
		assert.deepEqual(
			Object.entries(stored),
			Object.entries(mutation.record ?? {}),
		);
		const batch = await capture.read({
			scope,
			subscription: "sub_proto",
			after: start,
			limit: 10,
		});
		assert.deepEqual(
			Object.entries(batch.changes[0]?.record ?? {}),
			Object.entries(stored),
			"the journal and the table carry the same record",
		);
	});

	test("a record is re-parsed: one uuid in two spellings is one row", async () => {
		const byUuid = parseDatasetSchema({
			name: "subjects",
			keyFields: ["id"],
			fields: [
				{ name: "id", type: "uuid" },
				{ name: "note", type: "string", nullable: true },
			],
		});
		const { engine } = await open(storePath(), byUuid);
		const lower = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
		const canonical = put("", { id: lower, note: "first" }, byUuid);
		await engine.records.write({
			dataset: "subjects",
			mutations: [canonical],
		});
		// The caller's own spelling in the record, the canonical key beside it:
		// the record is normalised on the way in and lands on the same row.
		await engine.records.write({
			dataset: "subjects",
			mutations: [
				{
					tenant: "",
					key: canonical.key,
					op: "upsert",
					record: { id: lower.toUpperCase(), note: "second" },
				},
			],
		});
		assert.equal(engine.store.count(scopeOf("subjects")), 1);
		assert.deepEqual(
			await engine.records.read({
				dataset: "subjects",
				tenant: "",
				key: canonical.key,
			}),
			{ id: lower, note: "second" },
		);
		// A key that is not the canonical one is refused, for an upsert and for
		// a delete, and nothing lands.
		const uppercaseKey = JSON.stringify([lower.toUpperCase()]);
		await assert.rejects(
			async () => {
				await engine.records.write({
					dataset: "subjects",
					mutations: [
						{
							tenant: "",
							key: uppercaseKey,
							op: "upsert",
							record: { id: lower.toUpperCase(), note: "third" },
						},
					],
				});
			},
			{ code: "INVALID_RECORD" },
		);
		await assert.rejects(
			async () => {
				await engine.records.write({
					dataset: "subjects",
					mutations: [deleteMutation("", uppercaseKey)],
				});
			},
			{ code: "INVALID_RECORD" },
		);
		assert.equal(engine.store.count(scopeOf("subjects")), 1);
	});

	test("a mutation whose key names a different record than it carries is refused", async () => {
		const { engine } = await open();
		const one = put("", { id: "order-1", email: "one@example.test" });
		await assert.rejects(
			async () => {
				await engine.records.write({
					dataset: "orders",
					mutations: [{ ...one, key: keyOf("order-2") }],
				});
			},
			{ code: "INVALID_RECORD" },
		);
		assert.equal(engine.store.count(scopeOf("orders")), 0);
		// Applied changes take the same path.
		await assert.rejects(
			async () => {
				await requirePort(engine, "apply").apply({
					dataset: "orders",
					changes: [{ ...one, key: keyOf("order-2") }],
					source: "peer",
					position: "1",
				});
			},
			{ code: "INVALID_RECORD" },
		);
		assert.equal(engine.store.count(scopeOf("orders")), 0);
	});
});

describe("capture positions", () => {
	test("a position that is not one of this store's journal sequences is refused", async () => {
		const { engine } = await open();
		const capture = requirePort(engine, "capture");
		const scope = scopeOf("orders");
		await capture.start({ scope, subscription: "sub_a" });
		await engine.records.write({
			dataset: "orders",
			mutations: [put("", { id: "order-1" })],
		});
		for (const after of ["garbage", "", "-1", "1.5", "01", "1e3", "2"]) {
			await assert.rejects(
				async () => {
					await capture.read({
						scope,
						subscription: "sub_a",
						after,
						limit: 10,
					});
				},
				POSITION_REFUSED,
				`after ${JSON.stringify(after)}`,
			);
		}
		await assert.rejects(async () => {
			await capture.acknowledge({ subscription: "sub_a", position: "NaN" });
		}, POSITION_REFUSED);
		await assert.rejects(async () => {
			await capture.acknowledge({ subscription: "sub_a", position: "99" });
		}, POSITION_REFUSED);
		const batch = await capture.read({
			scope,
			subscription: "sub_a",
			after: "0",
			limit: 10,
		});
		assert.equal(batch.position, "1");
		assert.equal(batch.changes.length, 1);
	});

	test("reading from below the released floor is refused, not answered as caught up", async () => {
		const { engine } = await open();
		const capture = requirePort(engine, "capture");
		const scope = scopeOf("orders");
		const start = await capture.start({ scope, subscription: "sub_a" });
		await engine.records.write({
			dataset: "orders",
			mutations: [put("", { id: "order-1" })],
		});
		await engine.records.write({
			dataset: "orders",
			mutations: [put("", { id: "order-2" })],
		});
		const batch = await capture.read({
			scope,
			subscription: "sub_a",
			after: start,
			limit: 10,
		});
		assert.equal(batch.changes.length, 2);
		await capture.acknowledge({
			subscription: "sub_a",
			position: batch.position,
		});
		await assert.rejects(async () => {
			await capture.read({
				scope,
				subscription: "sub_a",
				after: start,
				limit: 10,
			});
		}, POSITION_REFUSED);
		const head = await capture.read({
			scope,
			subscription: "sub_a",
			after: batch.position,
			limit: 10,
		});
		assert.deepEqual(
			{ changes: head.changes.length, caughtUp: head.caughtUp },
			{ changes: 0, caughtUp: true },
		);
	});
});

describe("capture batches", () => {
	test("a batch never splits a write, even when that exceeds the limit", async () => {
		const { engine } = await open();
		const capture = requirePort(engine, "capture");
		const scope = scopeOf("orders");
		const start = await capture.start({ scope, subscription: "sub_a" });
		await engine.records.write({
			dataset: "orders",
			mutations: [
				put("", { id: "order-1" }),
				put("", { id: "order-2" }),
				put("", { id: "order-3" }),
			],
		});
		await engine.records.write({
			dataset: "orders",
			mutations: [put("", { id: "order-4" })],
		});
		const first = await capture.read({
			scope,
			subscription: "sub_a",
			after: start,
			limit: 2,
		});
		assert.deepEqual(
			first.changes.map((change) => change.record?.id),
			["order-1", "order-2", "order-3"],
			"the write's third change comes with the first two",
		);
		assert.equal(first.caughtUp, false);
		assert.equal(first.position, "3");
		const rest = await capture.read({
			scope,
			subscription: "sub_a",
			after: first.position,
			limit: 2,
		});
		assert.deepEqual(
			rest.changes.map((change) => change.record?.id),
			["order-4"],
		);
		assert.equal(rest.caughtUp, true);
		// A limit that ends exactly on a write's last change adds nothing, and a
		// whole write that is the last thing in the journal is caught up.
		const exact = await capture.read({
			scope,
			subscription: "sub_a",
			after: start,
			limit: 3,
		});
		assert.equal(exact.changes.length, 3);
		assert.equal(exact.caughtUp, false);
		const tail = await capture.read({
			scope,
			subscription: "sub_a",
			after: "3",
			limit: 1,
		});
		assert.equal(tail.changes.length, 1);
		assert.equal(tail.caughtUp, true);
	});

	test("a tenant-scoped batch keeps the tenant's part of a write whole", async () => {
		const { engine } = await open();
		const capture = requirePort(engine, "capture");
		const scope = scopeOf("orders", "acme");
		const start = await capture.start({ scope, subscription: "sub_t" });
		await engine.records.write({
			dataset: "orders",
			mutations: [
				put("acme", { id: "order-1" }),
				put("globex", { id: "order-2" }),
				put("acme", { id: "order-3" }),
				put("globex", { id: "order-4" }),
				put("acme", { id: "order-5" }),
			],
		});
		const batch = await capture.read({
			scope,
			subscription: "sub_t",
			after: start,
			limit: 1,
		});
		assert.deepEqual(
			batch.changes.map((change) => `${change.tenant}:${change.record?.id}`),
			["acme:order-1", "acme:order-3", "acme:order-5"],
		);
		assert.equal(batch.caughtUp, true);
	});

	test("a journal written before writes were marked gains the column and still reads", async () => {
		const file = storePath();
		const legacy = new DatabaseSync(file);
		legacy.exec(`
			CREATE TABLE hobo_data_journal (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				dataset TEXT NOT NULL,
				tenant_id TEXT NOT NULL,
				key TEXT NOT NULL,
				op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
				record TEXT
			);
			CREATE TABLE hobo_data_subscriptions (
				name TEXT PRIMARY KEY,
				dataset TEXT NOT NULL,
				start_position INTEGER NOT NULL,
				ack_position INTEGER NOT NULL
			);
			INSERT INTO hobo_data_subscriptions VALUES ('sub_old', 'orders', 0, 0);
			INSERT INTO hobo_data_journal (dataset, tenant_id, key, op, record) VALUES
				('orders', '', '["order-1"]', 'upsert', '{"email":null,"id":"order-1"}'),
				('orders', '', '["order-2"]', 'upsert', '{"email":null,"id":"order-2"}');
		`);
		legacy.close();
		const { engine } = await open(file);
		const batch = await requirePort(engine, "capture").read({
			scope: scopeOf("orders"),
			subscription: "sub_old",
			after: "0",
			limit: 1,
		});
		// Unmarked rows are one write each: the limit is honoured as before.
		assert.equal(batch.changes.length, 1);
		assert.equal(batch.caughtUp, false);
	});
});

describe("journal retention", () => {
	const PII = "pii-marker-4f1c@example.test";

	test("with no subscription a write leaves no payload in the journal", async () => {
		const { engine, file, close } = await open();
		const one = put("acme", { id: "order-1", email: PII });
		const written = await engine.records.write({
			dataset: "orders",
			mutations: [one],
		});
		const deleted = await engine.records.write({
			dataset: "orders",
			mutations: [deleteMutation("acme", one.key)],
		});
		assert.deepEqual(journal(file), []);
		// Positions still advance: the head is not the journal's row count.
		assert.deepEqual([written.position, deleted.position], ["1", "2"]);
		// A subscription that starts now starts after both, as it always did.
		const capture = requirePort(engine, "capture");
		const scope = scopeOf("orders");
		const start = await capture.start({ scope, subscription: "sub_late" });
		assert.equal(start, "2");
		const batch = await capture.read({
			scope,
			subscription: "sub_late",
			after: start,
			limit: 10,
		});
		assert.equal(batch.changes.length, 0);
		close();
		assert.ok(
			!readFileSync(file).includes(PII),
			"the deleted record is not readable anywhere in the store file",
		);
	});

	test("the journal is held for a subscription and released when the last one stops", async () => {
		const { engine, file } = await open();
		const capture = requirePort(engine, "capture");
		const scope = scopeOf("orders");
		await capture.start({ scope, subscription: "sub_a" });
		await capture.start({ scope, subscription: "sub_b" });
		await engine.records.write({
			dataset: "orders",
			mutations: [put("acme", { id: "order-1", email: PII })],
		});
		assert.equal(journal(file).length, 1);
		await capture.acknowledge({ subscription: "sub_a", position: "1" });
		assert.equal(journal(file).length, 1, "sub_b has not read it yet");
		await capture.stop("sub_b");
		assert.deepEqual(journal(file), [], "nobody is left who is owed it");
		await capture.stop("sub_a");
		await engine.records.write({
			dataset: "orders",
			mutations: [put("acme", { id: "order-2", email: PII })],
		});
		assert.deepEqual(journal(file), []);
	});

	test("a store left with unowed journal by an earlier version is released on open", async () => {
		const { file, close } = await open();
		close();
		const earlier = new DatabaseSync(file);
		earlier
			.prepare(
				"INSERT INTO hobo_data_journal (dataset, tenant_id, key, op, record) VALUES ('orders', 'acme', ?, 'upsert', ?)",
			)
			.run(keyOf("order-1"), JSON.stringify({ email: PII, id: "order-1" }));
		earlier.close();
		assert.equal(journal(file).length, 1);
		await open(file);
		assert.deepEqual(journal(file), []);
	});

	test("retire removes the scope's journal rows with its records", async () => {
		const { engine, file, close } = await open();
		const capture = requirePort(engine, "capture");
		const fence = requirePort(engine, "fence");
		const scope = scopeOf("orders", "acme");
		// A subscription that never acknowledges: the journal keeps everything.
		await capture.start({ scope: scopeOf("orders"), subscription: "sub_a" });
		const one = put("acme", { id: "order-1", email: PII });
		await engine.records.write({ dataset: "orders", mutations: [one] });
		await engine.records.write({
			dataset: "orders",
			mutations: [deleteMutation("acme", one.key)],
		});
		await engine.records.write({
			dataset: "orders",
			mutations: [
				put("acme", { id: "order-2", email: PII }),
				put("globex", { id: "order-3", email: "kept@example.test" }),
			],
		});
		assert.equal(journal(file).length, 4);
		const { fenceToken } = await fence.raise({ scope, reason: "erasure" });
		const expected = await requirePort(engine, "verify").digest({
			scope,
			buckets: 16,
		});
		const receipt = await requirePort(engine, "retire").retire({
			scope,
			fenceToken,
			expected,
		});
		assert.equal(receipt.removed, 1);
		assert.deepEqual(
			journal(file).map((row) => row.tenant_id),
			["globex"],
			"only the other tenant's change is left in the journal",
		);
		// The subscription sees what is left, and nothing of the retired scope.
		const batch = await capture.read({
			scope: scopeOf("orders"),
			subscription: "sub_a",
			after: "0",
			limit: 10,
		});
		assert.deepEqual(
			batch.changes.map((change) => change.tenant),
			["globex"],
		);
		close();
		const bytes = readFileSync(file);
		assert.ok(
			!bytes.includes(PII),
			"no version of the record survives in the file",
		);
		assert.ok(bytes.includes("kept@example.test"));
	});
});

describe("what the strengthened conformance kit found", () => {
	test("a subscription name is one reader of one scope: another tenant or dataset is refused, and the first reader is undisturbed", async () => {
		const { engine } = await open();
		const second = parseDatasetSchema({
			name: "invoices",
			keyFields: ["id"],
			fields: [{ name: "id", type: "string" }],
		});
		await engine.datasets.ensureDataset(second);
		const capture = requirePort(engine, "capture");
		const home = scopeOf("orders", "acme");
		const start = await capture.start({ scope: home, subscription: "sub_a" });
		// Written before anyone asks for the name elsewhere. Answered the first
		// scope's position, a reader of globex would be handed this change —
		// one made before it existed.
		await engine.records.write({
			dataset: "orders",
			mutations: [put("globex", { id: "order-early" })],
		});
		for (const other of [scopeOf("orders", "globex"), scopeOf("invoices")]) {
			await assert.rejects(
				async () => {
					await capture.start({ scope: other, subscription: "sub_a" });
				},
				{ name: "DataCoreError", code: "CAPTURE_SUBSCRIPTION_CONFLICT" },
			);
		}
		assert.equal(
			await capture.start({ scope: home, subscription: "sub_a" }),
			start,
			"the name still answers its own scope",
		);
		// Stopped, the name is free again — for any scope.
		await capture.stop("sub_a");
		await capture.start({
			scope: scopeOf("orders", "globex"),
			subscription: "sub_a",
		});
	});

	test("a subscription recorded before its tenant was kept is bound by the next scope that names it", async () => {
		const { file, close } = await open();
		close();
		const db = new DatabaseSync(file);
		db.exec(
			"INSERT INTO hobo_data_subscriptions (name, dataset, tenant_id, start_position, ack_position) VALUES ('sub_old', 'orders', NULL, 0, 0)",
		);
		db.close();
		const { engine } = await open(file);
		const capture = requirePort(engine, "capture");
		assert.equal(
			await capture.start({
				scope: scopeOf("orders", "acme"),
				subscription: "sub_old",
			}),
			"0",
		);
		await assert.rejects(
			async () => {
				await capture.start({
					scope: scopeOf("orders", "globex"),
					subscription: "sub_old",
				});
			},
			{ code: "CAPTURE_SUBSCRIPTION_CONFLICT" },
		);
	});

	test("a retire delivered again after it committed removes nothing and succeeds; a wrong token is still refused", async () => {
		const { engine } = await open();
		const scope = scopeOf("orders", "acme");
		await engine.records.write({
			dataset: "orders",
			mutations: [
				put("acme", { id: "order-1" }),
				put("globex", { id: "order-2" }),
			],
		});
		const { fenceToken } = await requirePort(engine, "fence").raise({
			scope,
			reason: "move",
		});
		const expected = await requirePort(engine, "verify").digest({
			scope,
			buckets: 16,
		});
		const retire = requirePort(engine, "retire");
		assert.equal(
			(await retire.retire({ scope, fenceToken, expected })).removed,
			1,
		);
		// The answer was lost, and the same request is sent again. It used to
		// be refused: the empty scope no longer matched the digest it named.
		assert.equal(
			(await retire.retire({ scope, fenceToken, expected })).removed,
			0,
		);
		await assert.rejects(
			async () => {
				await retire.retire({ scope, fenceToken: "not-it", expected });
			},
			{ code: "RETIRE_REFUSED" },
		);
	});
});

describe("fence tokens", () => {
	test("a fence raised again after release has a new token; the old one no longer writes", async () => {
		const { engine } = await open();
		const fence = requirePort(engine, "fence");
		const scope = scopeOf("orders", "acme");
		const first = await fence.raise({ scope, reason: "move" });
		assert.equal(
			(await fence.raise({ scope, reason: "move" })).fenceToken,
			first.fenceToken,
			"raising a raised fence returns its token",
		);
		await fence.release({ scope, fenceToken: first.fenceToken });
		// Same scope, same journal head, same clock: everything the token used
		// to be derived from is unchanged.
		const second = await fence.raise({ scope, reason: "move" });
		assert.notEqual(second.fenceToken, first.fenceToken);
		assert.ok(!first.fenceToken.includes("acme"), "nothing to guess from");
		await assert.rejects(
			async () => {
				await engine.records.write({
					dataset: "orders",
					mutations: [put("acme", { id: "order-1" })],
					fenceToken: first.fenceToken,
				});
			},
			{ code: "FENCED_WRITE" },
		);
		await engine.records.write({
			dataset: "orders",
			mutations: [put("acme", { id: "order-1" })],
			fenceToken: second.fenceToken,
		});
	});
});
