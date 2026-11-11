// Phase-7 milestone: a trail run against TWO REAL SQLite-backed stores.
// CDC dual-write replicates source writes to the target; the dual oracle
// asserts zero loss from live data. Injected divergence auto-compensates.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteDataDualPort } from "@hobo/data-sqlite";
import { afterEach, test } from "vitest";
import { defineTrail } from "../src/definition.js";
import { TrailRunner } from "../src/runner.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempStores() {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-dual-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return {
		sourcePath: path.join(dir, "source.db"),
		targetPath: path.join(dir, "target.db"),
	};
}

function migrationTrail() {
	return defineTrail({
		id: "app.checkout.migrate-live",
		version: "2026.08.03.1",
		description: "Live dual-store checkout migration",
		targets: ["silo-b"],
		steps: [
			{
				id: "schema-v1",
				kind: "schema",
				schema: {
					mode: "expand-contract",
					version: "2026080301",
					sql: "ALTER TABLE checkout ADD COLUMN tip_cents INT DEFAULT 0",
				},
				progressive: true,
			},
			{
				id: "data-dual",
				kind: "continuous-dual-data",
				dependsOn: ["schema-v1"],
				data: {
					mode: "cdc-dual",
					transformId: "checkout.live-replicate",
					checksum:
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				},
				progressive: true,
			},
		],
	});
}

test("milestone: trail cutover over two real SQLite stores with zero-loss dual oracle", () => {
	const { sourcePath, targetPath } = tempStores();
	const dual = createSqliteDataDualPort({ sourcePath, targetPath });
	cleanups.push(() => dual.close());

	// Business writes land on the source via CDC dual-write…
	dual.writeSource([
		{ id: "order-1", doc: { total: 100 } },
		{ id: "order-2", doc: { total: 250 } },
		{ id: "order-3", doc: { total: 75 } },
	]);
	assert.equal(dual.lag(), 3);
	// …the CDC tail replicates them to the target before the oracle judges.
	assert.equal(dual.replicate(), 3);
	assert.equal(dual.lag(), 0);

	const runner = new TrailRunner({
		tenant: "tenant-live",
		target: "silo-b",
		dataDual: dual,
	});
	const result = runner.run(migrationTrail());

	assert.equal(result.cutover, true);
	assert.equal(result.compensated, false);
	const dualResult = result.dataResults[0];
	assert.ok(dualResult);
	assert.equal(dualResult.fidelity, "live");
	assert.equal(dualResult.consistent, true);
	assert.equal(dualResult.zeroLoss, true);
	assert.equal(dualResult.sourceChecksum, dualResult.targetChecksum);
});

test("milestone: injected divergence in the live target auto-compensates", () => {
	const { sourcePath, targetPath } = tempStores();
	const dual = createSqliteDataDualPort({ sourcePath, targetPath });
	cleanups.push(() => dual.close());

	dual.writeSource([
		{ id: "order-1", doc: { total: 100 } },
		{ id: "order-2", doc: { total: 250 } },
	]);
	dual.replicate();

	// Inject divergence: a rogue write mutates the TARGET behind CDC's back.
	const rogue = new DatabaseSync(targetPath);
	rogue
		.prepare("UPDATE records SET doc = ? WHERE id = ?")
		.run(JSON.stringify({ total: 999 }), "order-2");
	rogue.close();

	const runner = new TrailRunner({
		tenant: "tenant-live",
		target: "silo-b",
		dataDual: dual,
	});
	const result = runner.run(migrationTrail());

	assert.equal(result.cutover, false);
	assert.equal(result.compensated, true);
	assert.equal(result.aborted, true);
	assert.equal(result.rampPercent, 0);
	const dualResult = result.dataResults[0];
	assert.ok(dualResult);
	assert.equal(dualResult.fidelity, "live");
	assert.equal(dualResult.consistent, false);
});

test("milestone: unreplicated CDC lag is a zero-loss violation, not a silent pass", () => {
	const { sourcePath, targetPath } = tempStores();
	const dual = createSqliteDataDualPort({ sourcePath, targetPath });
	cleanups.push(() => dual.close());

	dual.writeSource([{ id: "order-1", doc: { total: 100 } }]);
	dual.replicate();
	// A write arrives after the last replication cycle…
	dual.writeSource([{ id: "order-2", doc: { total: 55 } }]);
	assert.equal(dual.lag(), 1);

	const runner = new TrailRunner({
		tenant: "tenant-live",
		target: "silo-b",
		dataDual: dual,
	});
	const result = runner.run(migrationTrail());
	// …so the oracle sees source ≠ target and compensates instead of cutting over.
	assert.equal(result.compensated, true);

	// Catch up and rerun: zero loss proven, cutover proceeds.
	assert.equal(dual.replicate(), 1);
	const retry = new TrailRunner({
		tenant: "tenant-live",
		target: "silo-b",
		dataDual: dual,
	}).run(migrationTrail());
	assert.equal(retry.cutover, true);
	assert.equal(retry.dataResults[0]?.zeroLoss, true);
});

test("pooled → siloed: tenant-scoped replication ignores other tenants' rows", () => {
	const { sourcePath, targetPath } = tempStores();
	// Pooled source: rows for two tenants; target is tenant-a's silo.
	const pooledWriter = createSqliteDataDualPort({ sourcePath, targetPath });
	pooledWriter.writeSource([
		{ id: "order-1", doc: { total: 10 }, tenant: "tenant-a" },
		{ id: "order-2", doc: { total: 20 }, tenant: "tenant-b" },
		{ id: "order-3", doc: { total: 30 }, tenant: "tenant-a" },
	]);
	pooledWriter.close();

	const silo = createSqliteDataDualPort({
		sourcePath,
		targetPath,
		tenant: "tenant-a",
	});
	cleanups.push(() => silo.close());

	assert.equal(silo.lag(), 2, "only tenant-a changes are in scope");
	assert.equal(silo.replicate(), 2);

	const view = silo.snapshot();
	assert.deepEqual(
		view.sourceRows.map((row) => row.id),
		["order-1", "order-3"],
	);
	assert.deepEqual(view.sourceRows, view.targetRows);

	const runner = new TrailRunner({
		tenant: "tenant-a",
		target: "silo-a",
		dataDual: silo,
	});
	const result = runner.run(migrationTrail());
	assert.equal(result.cutover, true);
	assert.equal(result.dataResults[0]?.zeroLoss, true);
});
