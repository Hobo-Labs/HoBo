// The pgoutput decoder against bytes recorded from a real server. Always on:
// no database is needed to prove the decoder reads what a server sends,
// because what a server sends is checked in.
//
// The fixture was recorded by `recordPgOutputScenario` (test/engine-support.ts)
// and the live lane re-runs that scenario to prove the bytes are still
// representative. A few messages a dataset table can never produce (origin,
// type, logical message) are built by hand below and labelled as such.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	canonicalEncode,
	deleteMutation,
	parseCanonicalRecord,
	type RecordMutation,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import {
	decodePgOutputMessage,
	decodePgOutputTransactions,
	mutationsOf,
	type PgOutputRowChange,
	type PgOutputTransaction,
	PostgresDataError,
} from "../src/index.js";
import {
	EVERY_TYPE_RECORD,
	EVERY_TYPE_SCHEMA,
	LARGE_NOTE,
	PGOUTPUT_FIXTURE_NAMESPACE,
	type RecordedPgOutput,
} from "./engine-support.js";

// SAFETY: the fixture file is this repository's own recorded document.
const FIXTURE = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("./fixtures/pgoutput-v1.recorded.json", import.meta.url),
		),
		"utf8",
	),
) as RecordedPgOutput;

const MESSAGES: readonly Uint8Array[] = FIXTURE.messages.map((hex) =>
	Buffer.from(hex, "hex"),
);
const schema = EVERY_TYPE_SCHEMA;

function transactions(): readonly PgOutputTransaction[] {
	return decodePgOutputTransactions(MESSAGES).transactions;
}

function change(transaction: number, index = 0): PgOutputRowChange {
	const found = transactions()[transaction]?.changes[index];
	if (found === undefined) throw new Error("fixture has no such change");
	return found;
}

const never = async (): Promise<RecordMutation | undefined> => {
	throw new Error("the store must not be consulted for this change");
};

function canonical(overrides: {
	readonly [field: string]: string | number | null;
}) {
	return parseCanonicalRecord(schema, { ...EVERY_TYPE_RECORD, ...overrides });
}

function undecodable(action: () => void): void {
	assert.throws(action, (cause) => {
		assert.ok(cause instanceof PostgresDataError);
		assert.equal(cause.code, "CAPTURE_STREAM_UNDECODABLE");
		return true;
	});
}

describe("pgoutput decoder — recorded bytes", () => {
	test("the stream is whole transactions in commit order", () => {
		const kinds = MESSAGES.map((bytes) => decodePgOutputMessage(bytes).kind);
		assert.equal(
			kinds.join(" "),
			[
				"begin relation insert commit",
				"begin update commit",
				"begin insert insert delete commit",
				"begin update commit",
				"begin insert commit",
				"begin update commit",
				"begin relation update commit",
				"begin delete commit",
				"begin relation delete commit",
				"begin relation truncate commit",
			].join(" "),
		);
		const decoded = transactions();
		assert.equal(decoded.length, 10);
		assert.deepEqual(
			decoded.map((transaction) => transaction.changes.length),
			[1, 1, 3, 1, 1, 1, 1, 1, 1, 1],
		);
		for (const [index, transaction] of decoded.entries()) {
			assert.ok(transaction.endLsn > transaction.commitLsn);
			const previous = decoded[index - 1];
			if (previous !== undefined) {
				assert.ok(transaction.endLsn > previous.endLsn, "commit order");
				assert.ok(transaction.xid > previous.xid);
			}
		}
	});

	test("a relation is described with its key columns and identity", () => {
		const first = decodePgOutputMessage(MESSAGES[1] ?? new Uint8Array());
		assert.equal(first.kind, "relation");
		if (first.kind !== "relation") return;
		assert.equal(first.relation.namespace, PGOUTPUT_FIXTURE_NAMESPACE);
		assert.equal(first.relation.name, schema.name);
		assert.equal(first.relation.replicaIdentity, "d");
		assert.deepEqual(
			first.relation.columns.map((column) => column.name),
			["tenant_id", ...schema.fields.map((field) => field.name)],
		);
		assert.deepEqual(
			first.relation.columns.filter((column) => column.key).map((c) => c.name),
			["tenant_id", "id"],
		);
		// The server re-describes the relation after the identity changes.
		const described = MESSAGES.map((bytes) => decodePgOutputMessage(bytes))
			.flatMap((message) =>
				message.kind === "relation" ? [message.relation.replicaIdentity] : [],
			)
			.join("");
		assert.equal(described, "dfdd");
	});

	test("an insert decodes to the canonical record that was written", async () => {
		const mutations = await mutationsOf(schema, change(0), never);
		assert.equal(mutations.length, 1);
		const [mutation] = mutations;
		assert.equal(mutation?.op, "upsert");
		assert.equal(mutation?.tenant, "");
		assert.equal(mutation?.key, '["order-1"]');
		// Byte-identical: numeric trailing zeros, the UTC instant, hex bytes
		// and jsonb key order have all been normalised away.
		assert.equal(
			canonicalEncode(mutation?.record ?? null),
			canonicalEncode(canonical({})),
		);
		assert.equal(mutation?.record?.price, "1234.56");
		assert.equal(mutation?.record?.placed_at, "2026-01-02T03:04:05.678901Z");
		assert.equal(mutation?.record?.blob, "AAECA/8=");
	});

	test("an update carries the new row only, and the int64 minimum survives", async () => {
		const updated = change(1);
		assert.equal(updated.op, "update");
		assert.equal(updated.op === "update" ? updated.old : null, undefined);
		const [mutation] = await mutationsOf(schema, updated, never);
		assert.equal(mutation?.record?.qty, "-9223372036854775808");
	});

	test("one transaction's changes stay together, with tenants and NULLs", async () => {
		const [inserted] = await mutationsOf(schema, change(2, 0), never);
		assert.equal(inserted?.tenant, "tenant-b");
		assert.equal(inserted?.record?.note, null);
		assert.equal(inserted?.record?.card, null);
		const [other] = await mutationsOf(schema, change(2, 1), never);
		assert.equal(other?.tenant, "tenant-a");
		// A delete carries the key image only: tenant plus key columns.
		const removed = change(2, 2);
		assert.equal(removed.op === "delete" ? removed.oldImage : "", "key");
		assert.deepEqual(await mutationsOf(schema, removed, never), [
			deleteMutation("tenant-a", '["order-3"]'),
		]);
	});

	test("a key-changing update is a delete of the old key, then an upsert", async () => {
		const moved = change(3);
		assert.equal(moved.op === "update" ? moved.oldImage : "", "key");
		const mutations = await mutationsOf(schema, moved, never);
		assert.deepEqual(
			mutations.map(
				(mutation) => `${mutation.op} ${mutation.tenant} ${mutation.key}`,
			),
			['delete tenant-b ["order-2"]', 'upsert tenant-b ["order-2-moved"]'],
		);
	});

	test("an untouched out-of-line value arrives as a placeholder and is re-read", async () => {
		const [inserted] = await mutationsOf(schema, change(4), never);
		assert.equal(inserted?.record?.note, LARGE_NOTE);

		const updated = change(5);
		assert.equal(updated.op, "update");
		if (updated.op !== "update") return;
		assert.deepEqual(updated.row.get("note"), { kind: "unchanged" });
		assert.equal(updated.old, undefined);
		// Default identity: no old image, so the row is completed from the store.
		const asked: string[] = [];
		const current: RecordMutation = {
			tenant: "",
			key: '["order-4"]',
			op: "upsert",
			record: canonical({ id: "order-4", note: LARGE_NOTE, qty: "41" }),
		};
		const completed = await mutationsOf(
			schema,
			updated,
			async (tenant, key) => {
				asked.push(`${tenant}|${key}`);
				return current;
			},
		);
		assert.deepEqual(asked, ['|["order-4"]']);
		assert.deepEqual(completed, [current]);
		// Gone from the store by now: nothing is emitted; its delete follows.
		assert.deepEqual(
			await mutationsOf(schema, updated, async () => undefined),
			[],
		);
	});

	test("with a full identity the placeholder is filled from the old image", async () => {
		const updated = change(6);
		assert.equal(updated.op === "update" ? updated.oldImage : "", "full");
		if (updated.op !== "update") return;
		assert.equal(updated.relation.replicaIdentity, "f");
		assert.deepEqual(updated.row.get("note"), { kind: "unchanged" });
		const [mutation] = await mutationsOf(schema, updated, never);
		assert.equal(mutation?.record?.qty, "42");
		assert.equal(mutation?.record?.note, LARGE_NOTE);
		assert.equal(mutation?.key, '["order-4"]');
		// A full-image delete still yields just the key.
		assert.deepEqual(await mutationsOf(schema, change(7), never), [
			deleteMutation("", '["order-4"]'),
		]);
		assert.deepEqual(await mutationsOf(schema, change(8), never), [
			deleteMutation("", '["order-1"]'),
		]);
	});

	test("a truncate decodes, and is refused as a record change", async () => {
		const truncated = change(9);
		assert.equal(truncated.op, "truncate");
		if (truncated.op !== "truncate") return;
		assert.deepEqual(
			truncated.relations.map((relation) => relation.name),
			[schema.name],
		);
		await assert.rejects(mutationsOf(schema, truncated, never), (cause) => {
			assert.ok(cause instanceof PostgresDataError);
			assert.equal(cause.code, "CAPTURE_STREAM_UNDECODABLE");
			return true;
		});
	});

	test("damaged or incomplete streams are refused, never partly decoded", () => {
		const insert = MESSAGES[2] ?? new Uint8Array();
		// Cut short, padded, and retagged.
		undecodable(() =>
			decodePgOutputMessage(insert.subarray(0, insert.length - 3)),
		);
		undecodable(() =>
			decodePgOutputMessage(Buffer.concat([insert, Buffer.from([0])])),
		);
		undecodable(() => decodePgOutputMessage(new Uint8Array()));
		undecodable(() => decodePgOutputMessage(Buffer.from("5a00", "hex")));
		// A change for a relation nobody described.
		undecodable(() =>
			decodePgOutputTransactions(MESSAGES.filter((_, index) => index !== 1)),
		);
		// A stream that stops inside a transaction.
		undecodable(() => decodePgOutputTransactions(MESSAGES.slice(0, 3)));
		// A change with no transaction around it.
		undecodable(() => decodePgOutputTransactions(MESSAGES.slice(1, 3)));
		// A relation described by an earlier call is remembered by the caller.
		const earlier = decodePgOutputTransactions(MESSAGES.slice(0, 4));
		const later = decodePgOutputTransactions(
			MESSAGES.slice(4, 7),
			earlier.relations,
		);
		assert.equal(later.transactions.length, 1);
	});
});

describe("pgoutput decoder — hand-built messages", () => {
	// Not recorded: a dataset table cannot make a server emit these, so they
	// are assembled from the protocol documentation.
	const cstring = (text: string): Buffer =>
		Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
	const uint32 = (value: number): Buffer => {
		const out = Buffer.alloc(4);
		out.writeUInt32BE(value);
		return out;
	};
	const uint64 = (value: bigint): Buffer => {
		const out = Buffer.alloc(8);
		out.writeBigUInt64BE(value);
		return out;
	};

	test("origin, type and logical messages decode and carry no row change", () => {
		const origin = Buffer.concat([
			Buffer.from("O"),
			uint64(0x16n),
			cstring("up"),
		]);
		assert.deepEqual(decodePgOutputMessage(origin), {
			kind: "origin",
			lsn: 0x16n,
			name: "up",
		});
		const type = Buffer.concat([
			Buffer.from("Y"),
			uint32(16_400),
			cstring("public"),
			cstring("mood"),
		]);
		assert.deepEqual(decodePgOutputMessage(type), {
			kind: "type",
			oid: 16_400,
			namespace: "public",
			name: "mood",
		});
		const logical = Buffer.concat([
			Buffer.from("M"),
			Buffer.from([1]),
			uint64(0x2an),
			cstring("hobo"),
			uint32(2),
			Buffer.from("hi"),
		]);
		const decoded = decodePgOutputMessage(logical);
		assert.equal(decoded.kind, "message");
		if (decoded.kind !== "message") return;
		assert.equal(decoded.transactional, true);
		assert.equal(decoded.prefix, "hobo");
		assert.equal(Buffer.from(decoded.content).toString(), "hi");

		const begin = MESSAGES[0] ?? new Uint8Array();
		const commit = MESSAGES[3] ?? new Uint8Array();
		const result = decodePgOutputTransactions([
			begin,
			origin,
			type,
			logical,
			commit,
		]);
		assert.deepEqual(result.transactions[0]?.changes, []);
	});

	test("formats this binding never asks for are refused by name", () => {
		// A binary-format column inside an insert.
		const binary = Buffer.concat([
			Buffer.from("I"),
			uint32(1),
			Buffer.from("N"),
			Buffer.from([0, 1]),
			Buffer.from("b"),
			uint32(1),
			Buffer.from([7]),
		]);
		undecodable(() => decodePgOutputMessage(binary));
		// Stream start, which needs protocol version 2.
		undecodable(() =>
			decodePgOutputMessage(Buffer.concat([Buffer.from("S"), uint32(1)])),
		);
		// Text that is not UTF-8.
		const invalid = Buffer.concat([
			Buffer.from("I"),
			uint32(1),
			Buffer.from("N"),
			Buffer.from([0, 1]),
			Buffer.from("t"),
			uint32(1),
			Buffer.from([0xff]),
		]);
		undecodable(() => decodePgOutputMessage(invalid));
	});
});
