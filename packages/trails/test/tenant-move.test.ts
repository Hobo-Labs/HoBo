// M3 Release Candidate: pooled → siloed tenant move with REAL SQLite-backed
// fence + export/import ports driven through the identity spectrum-cutover
// protocol. Zero-loss conformance: source quiescent seq == silo head, zero
// lost/duplicated rows. Reap is destructive and gated on the proven move.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteDataDualPort, FencedTenantError } from "@hobo/data-sqlite";
import { runSpectrumIdentityCutover } from "@hobo/identity";
import { afterEach, test } from "vitest";
import { MIGRATION_EVENTS } from "../src/migration-executor.js";
import { createTenantMovePorts } from "../src/tenant-move-port.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempStores() {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-move-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return {
		sourcePath: path.join(dir, "pooled.db"),
		targetPath: path.join(dir, "silo-a.db"),
	};
}

test("milestone: spectrum cutover over real ports is zero-loss (quiescent seq == silo head)", () => {
	const { sourcePath, targetPath } = tempStores();
	// Seed the POOLED store with two tenants through an unscoped port.
	const pooled = createSqliteDataDualPort({ sourcePath, targetPath });
	pooled.writeSource([
		{ id: "order-1", doc: { total: 10 }, tenant: "tenant-a" },
		{ id: "order-2", doc: { total: 20 }, tenant: "tenant-b" },
		{ id: "order-3", doc: { total: 30 }, tenant: "tenant-a" },
		{ id: "order-4", doc: { total: 40 }, tenant: "tenant-a" },
	]);
	pooled.close();

	const dual = createSqliteDataDualPort({
		sourcePath,
		targetPath,
		tenant: "tenant-a",
	});
	cleanups.push(() => dual.close());
	const move = createTenantMovePorts({
		dual,
		tenant: "tenant-a",
		clock: () => "2026-08-03T00:00:00.000Z",
	});

	const result = runSpectrumIdentityCutover({
		tenant: "tenant-a",
		sourceAdapter: "pooled-sqlite",
		targetAdapter: "siloed-sqlite",
		streamIds: ["records:tenant-a"],
		fence: move.fence,
		transfer: move.transfer,
	});

	assert.equal(result.ok, true);
	assert.equal(result.phase, "resumed");
	assert.equal(result.zeroLoss, true);
	assert.equal(result.sourceHeadSeq, result.importedHeadSeq);
	assert.ok(result.fenceToken);

	// The silo holds exactly tenant-a's rows; tenant-b never crossed.
	const view = dual.snapshot();
	assert.deepEqual(
		view.targetRows.map((row) => row.id),
		["order-1", "order-3", "order-4"],
	);
	assert.deepEqual(view.sourceRows, view.targetRows);

	// migration.Exported / Imported facts carry matching head seqs.
	const exported = move.facts.find(
		(fact) => fact.type === MIGRATION_EVENTS.Exported,
	);
	const imported = move.facts.find(
		(fact) => fact.type === MIGRATION_EVENTS.Imported,
	);
	assert.ok(exported && imported);
	// SAFETY: the preceding fact-type checks establish these event payloads.
	assert.equal(
		(exported.data as { headSeq: number }).headSeq,
		(imported.data as { importedHeadSeq: number }).importedHeadSeq,
	);
});

test("milestone: fenced tenant writes are refused; other tenants keep writing", () => {
	const { sourcePath, targetPath } = tempStores();
	const dual = createSqliteDataDualPort({
		sourcePath,
		targetPath,
		tenant: "tenant-a",
	});
	cleanups.push(() => dual.close());
	dual.writeSource([{ id: "order-1", doc: { total: 10 } }]);

	const move = createTenantMovePorts({ dual, tenant: "tenant-a" });
	move.fence.raiseFence({
		tenant: "tenant-a",
		streamIds: ["records:tenant-a"],
	});

	// The write half of the zero-loss guarantee: fenced writes fail closed.
	assert.throws(
		() => dual.writeSource([{ id: "order-9", doc: { total: 99 } }]),
		FencedTenantError,
	);
	// A different tenant's writes still land (only the moved tenant froze).
	dual.writeSource([{ id: "other-1", doc: { total: 5 }, tenant: "tenant-b" }]);
});

test("milestone: reap deletes the pooled copy only after a proven move", () => {
	const { sourcePath, targetPath } = tempStores();
	const dual = createSqliteDataDualPort({
		sourcePath,
		targetPath,
		tenant: "tenant-a",
	});
	cleanups.push(() => dual.close());
	dual.writeSource([
		{ id: "order-1", doc: { total: 10 } },
		{ id: "order-2", doc: { total: 20 } },
	]);
	const move = createTenantMovePorts({ dual, tenant: "tenant-a" });

	// Unproven: not fenced yet → refuse.
	assert.throws(() => move.reap(), /not fenced/u);

	move.fence.raiseFence({
		tenant: "tenant-a",
		streamIds: ["records:tenant-a"],
	});
	// Fenced but not drained → refuse (data would be lost).
	assert.throws(() => move.reap(), /un-replicated/u);

	move.drain();
	const { reaped } = move.reap();
	assert.equal(reaped, 2);
	// Source is empty for the tenant; silo remains authoritative.
	const view = dual.snapshot();
	assert.deepEqual(view.sourceRows, []);
	assert.equal(view.targetRows.length, 2);
});

test("brownfield backfill covers rows written before the port existed", () => {
	const { sourcePath, targetPath } = tempStores();
	// Rows created OUTSIDE the CDC port (no journal entries).
	const legacy = new DatabaseSync(sourcePath);
	legacy.exec(`
		CREATE TABLE records (
			tenant_id TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id)
		);
		INSERT INTO records (tenant_id, id, doc) VALUES
			('tenant-a', 'legacy-1', '{"total":1}'),
			('tenant-a', 'legacy-2', '{"total":2}');
	`);
	legacy.close();

	const dual = createSqliteDataDualPort({
		sourcePath,
		targetPath,
		tenant: "tenant-a",
	});
	cleanups.push(() => dual.close());

	assert.equal(dual.lag(), 0, "legacy rows are invisible to the CDC tail");
	assert.equal(dual.backfill(), 2);
	const view = dual.snapshot();
	assert.deepEqual(view.sourceRows, view.targetRows);
	// New writes after backfill flow through the tail as usual.
	dual.writeSource([{ id: "new-1", doc: { total: 3 } }]);
	assert.equal(dual.lag(), 1);
	dual.replicate();
	assert.deepEqual(dual.snapshot().sourceRows, dual.snapshot().targetRows);
});
