// The synchronous dual-run port over two real SQLite files: the port
// @hobo/trails runs its live lanes on. Includes the three interactions of
// contracts/pacts/sqlite-dual-run.pact.json, replayed for real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	encodeRecordKey,
	type JsonObject,
	parseCanonicalRecord,
	parseDatasetSchema,
	upsertMutation,
} from "@hobo/data-core";
import { afterEach, describe, test } from "vitest";
import {
	createSqliteDataDualPort,
	createSqliteEngine,
	FencedTenantError,
} from "../src/index.js";
import { tempDir } from "./support.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function stores() {
	const { dir, remove } = tempDir("hobo-sqlite-dual-");
	cleanups.push(remove);
	return {
		sourcePath: path.join(dir, "source.db"),
		targetPath: path.join(dir, "target.db"),
	};
}

function open(tenant?: string, paths = stores()) {
	const dual = createSqliteDataDualPort({
		...paths,
		...(tenant === undefined ? undefined : { tenant }),
	});
	cleanups.push(() => dual.close());
	return { dual, paths };
}

/** The error an action throws, or undefined when it does not throw. */
function thrown(action: () => void): Error | undefined {
	try {
		action();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	return undefined;
}

interface Interaction {
	readonly description: string;
	readonly response: { readonly status: number; readonly body: JsonObject };
}

const here = path.dirname(fileURLToPath(import.meta.url));
// SAFETY: the pact file is a JSON document checked in beside this test.
const pact = JSON.parse(
	readFileSync(
		path.join(here, "..", "contracts", "pacts", "sqlite-dual-run.pact.json"),
		"utf8",
	),
) as { interactions: Interaction[] };
const [evidencePact, fencedPact, reapPact] = pact.interactions;

describe("SQLite dual-run port", () => {
	test("writes land on the source and its journal together; replicate tails them once", () => {
		const { dual } = open();
		dual.writeSource([
			{ id: "order-1", doc: { total: 100 } },
			{ id: "order-2", doc: { total: 250 } },
		]);
		assert.equal(dual.lag(), 2);
		assert.equal(dual.replicate(), 2);
		assert.equal(dual.lag(), 0);
		assert.equal(dual.replicate(), 0, "nothing is replicated twice");
		dual.writeSource([
			{ id: "order-1", doc: { total: 101 } },
			{ id: "order-2", doc: {}, deleted: true },
		]);
		assert.equal(dual.replicate(), 2);
		assert.deepEqual(dual.snapshot().targetRows, [
			{ tenant: "default", id: "order-1", total: 101 },
		]);
		assert.equal(dual.appliedWatermark(), dual.headSeq());
	});

	test(evidencePact?.description ?? "evidence", () => {
		assert.ok(evidencePact);
		const { dual } = open();
		dual.writeSource([
			{ id: "order-1", doc: { total: 1 } },
			{ id: "order-2", doc: { total: 2 } },
			{ id: "order-3", doc: { total: 3 } },
		]);
		dual.replicate();
		const evidence = dual.evidence();
		assert.deepEqual(
			{
				sourceCount: evidence.source.count,
				targetCount: evidence.target.count,
				consistent: evidence.consistent,
				fidelity: evidence.fidelity,
				keys: Object.keys(evidence).sort(),
			},
			evidencePact.response.body,
		);
		assert.match(evidence.source.digest, /^[0-9a-f]{64}$/u);
		assert.ok(
			!JSON.stringify(evidence).includes("order-1"),
			"no row in the evidence",
		);
	});

	test("evidence sees a rogue write the row counts alone would miss", () => {
		const { dual, paths } = open();
		dual.writeSource([
			{ id: "order-1", doc: { total: 100 } },
			{ id: "order-2", doc: { total: 250 } },
		]);
		dual.replicate();
		assert.equal(dual.evidence().consistent, true);
		const rogue = new DatabaseSync(paths.targetPath);
		rogue
			.prepare("UPDATE records SET doc = ? WHERE id = ?")
			.run(JSON.stringify({ total: 999 }), "order-2");
		rogue.close();
		const evidence = dual.evidence();
		assert.equal(evidence.source.count, evidence.target.count);
		assert.equal(evidence.consistent, false);
	});

	test(fencedPact?.description ?? "fenced", () => {
		assert.ok(fencedPact);
		const { dual } = open();
		dual.writeSource([{ id: "order-1", doc: { total: 1 }, tenant: "acme" }]);
		const { fenceToken } = dual.raiseFence("acme");
		assert.equal(
			dual.raiseFence("acme").fenceToken,
			fenceToken,
			"raise is idempotent",
		);
		assert.ok(dual.isFenced("acme"));
		const error = thrown(() =>
			dual.writeSource([{ id: "order-9", doc: { total: 9 }, tenant: "acme" }]),
		);
		assert.ok(error instanceof FencedTenantError);
		// The refused writer is exactly who must not learn the token.
		assert.ok(
			!`${error.message} ${JSON.stringify(error)} ${JSON.stringify(error.detail)}`.includes(
				fenceToken,
			),
			"the error does not carry the fence token",
		);
		assert.ok(!Object.values(error).includes(fenceToken));
		assert.deepEqual(
			{ error: { name: error.name, code: error.code, tenant: error.tenant } },
			fencedPact.response.body,
		);
		// Another tenant on the same pooled store is untouched.
		dual.writeSource([{ id: "order-2", doc: { total: 2 }, tenant: "globex" }]);
	});

	test(reapPact?.description ?? "reap", () => {
		assert.ok(reapPact);
		const { paths } = open();
		const { dual } = open("acme", paths);
		dual.writeSource([{ id: "order-1", doc: { total: 1 } }]);
		assert.throws(() => dual.reapSource("acme"), /not fenced/u);
		dual.raiseFence("acme");
		const error = thrown(() => dual.reapSource("acme"));
		assert.ok(error !== undefined);
		assert.deepEqual(
			{ error: { refused: error.message.replace("reap refused: ", "") } },
			reapPact.response.body,
		);
		dual.replicate();
		assert.deepEqual(dual.reapSource("acme"), { reaped: 1 });
		assert.equal(dual.evidence().source.count, 0);
		assert.equal(dual.evidence().target.count, 1);
	});

	test("a reap is refused when the silo does not match the pooled rows", () => {
		const { paths } = open();
		const { dual } = open("acme", paths);
		dual.writeSource([{ id: "order-1", doc: { total: 1 } }]);
		dual.replicate();
		dual.raiseFence("acme");
		const rogue = new DatabaseSync(paths.targetPath);
		rogue
			.prepare("UPDATE records SET doc = ?")
			.run(JSON.stringify({ total: 2 }));
		rogue.close();
		assert.throws(() => dual.reapSource("acme"), /not checksum-equal/u);
	});

	test("a port with no tenant also refuses to reap rows the target does not hold", () => {
		const paths = stores();
		// Rows that predate the journal: nothing to replicate, nothing pending.
		const legacy = new DatabaseSync(paths.sourcePath);
		legacy.exec(`
			CREATE TABLE records (
				tenant_id TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL,
				PRIMARY KEY (tenant_id, id)
			);
			INSERT INTO records (tenant_id, id, doc) VALUES
				('acme', 'legacy-1', '{"total":1}'),
				('acme', 'legacy-2', '{"total":2}');
		`);
		legacy.close();
		const { dual } = open(undefined, paths);
		dual.raiseFence("acme");
		assert.equal(dual.lag(), 0);
		assert.throws(() => dual.reapSource("acme"), /not checksum-equal/u);
		assert.equal(dual.evidence().source.count, 2, "the source rows are intact");
		assert.equal(dual.evidence().target.count, 0);
		// Once the target really holds them, the reap goes through.
		dual.backfill();
		assert.deepEqual(dual.reapSource("acme"), { reaped: 2 });
	});

	test("a reap leaves none of the tenant's changes in the source journal", () => {
		const { paths } = open();
		const { dual } = open("acme", paths);
		dual.writeSource([
			{ id: "order-1", doc: { email: "pii-marker@example.test" } },
			{ id: "order-2", doc: { total: 2 }, tenant: "globex" },
		]);
		dual.replicate();
		dual.raiseFence("acme");
		assert.deepEqual(dual.reapSource("acme"), { reaped: 1 });
		const source = new DatabaseSync(paths.sourcePath);
		const left = source
			.prepare("SELECT tenant_id FROM hobo_data_journal")
			.all()
			.map((row) => String(row.tenant_id));
		source.close();
		assert.deepEqual(left, ["globex"]);
	});

	test("changes released before the port pinned the journal are backfill's, not the tail's", () => {
		const paths = stores();
		// Written through the engine with no subscription: applied, not kept.
		const engine = createSqliteEngine({ path: paths.sourcePath });
		const schema = parseDatasetSchema({
			name: "records",
			version: 1,
			keyFields: ["id"],
			fields: [
				{ name: "id", type: "string", nullable: false },
				{ name: "doc", type: "json", nullable: false },
			],
		});
		engine.datasets.ensureDataset(schema);
		const record = parseCanonicalRecord(schema, {
			id: "early-1",
			doc: { total: 1 },
		});
		engine.records.write({
			dataset: "records",
			mutations: [
				upsertMutation("default", encodeRecordKey(schema, record), record),
			],
		});
		engine.close();
		const { dual } = open(undefined, paths);
		assert.equal(dual.lag(), 0);
		assert.equal(dual.replicate(), 0);
		assert.equal(dual.evidence().consistent, false);
		assert.equal(dual.backfill(), 1);
		dual.writeSource([{ id: "late-1", doc: { total: 2 } }]);
		assert.equal(dual.lag(), 1);
		assert.equal(dual.replicate(), 1);
		assert.equal(dual.evidence().consistent, true);
	});

	test("a tenant-scoped port replicates only its tenant, and its head is its own", () => {
		const { dual: pooled, paths } = open();
		pooled.writeSource([
			{ id: "order-1", doc: { total: 10 }, tenant: "acme" },
			{ id: "order-2", doc: { total: 20 }, tenant: "globex" },
			{ id: "order-3", doc: { total: 30 }, tenant: "acme" },
			{ id: "order-4", doc: { total: 40 }, tenant: "globex" },
		]);
		const { dual: silo } = open("acme", paths);
		assert.equal(silo.lag(), 2);
		assert.equal(silo.replicate(), 2);
		// The scope's head is its last own change, not the store's last change.
		assert.equal(silo.headSeq(), 3);
		assert.equal(silo.appliedWatermark(), 3);
		assert.deepEqual(
			silo.snapshot().targetRows.map((row) => row.id),
			["order-1", "order-3"],
		);
	});

	test("a brownfield table written before the port existed is adopted and backfilled", () => {
		const paths = stores();
		const legacy = new DatabaseSync(paths.sourcePath);
		legacy.exec(`
			CREATE TABLE records (
				tenant_id TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL,
				PRIMARY KEY (tenant_id, id)
			);
			INSERT INTO records (tenant_id, id, doc) VALUES
				('acme', 'legacy-1', '{"total":1}'),
				('acme', 'legacy-2', '{"total":2}');
		`);
		legacy.close();
		const { dual } = open("acme", paths);
		assert.equal(
			dual.lag(),
			0,
			"rows written outside the port were never journaled",
		);
		assert.equal(dual.backfill(), 2);
		assert.equal(dual.evidence().consistent, true);
		dual.writeSource([{ id: "new-1", doc: { total: 3 } }]);
		assert.equal(dual.lag(), 1);
		dual.replicate();
		assert.equal(dual.evidence().target.count, 3);
	});

	test("a non-identifier table name is refused before any SQL is built", () => {
		assert.throws(
			() =>
				createSqliteDataDualPort({
					...stores(),
					table: "records; DROP TABLE x",
				}),
			/invalid SQL identifier/u,
		);
	});
});
