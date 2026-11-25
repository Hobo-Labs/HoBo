// M1 Dogfood/Alpha evidence: the promoted HOBO-499 dry-run contract plus the
// remaining "Evidence Required For M1" rows (compatibility-input matrix,
// rollback evidence, scope-boundary register, support handoff).
import assert from "node:assert/strict";
import { test } from "vitest";

import {
	assertUpgradeScopeBoundary,
	COMPATIBILITY_INPUT_MATRIX,
	classifyUpgradeDryRunDecision,
	evaluateUpgradeDryRun,
	parseCompatibilityInputs,
	parseRollbackEvidence,
	UPGRADE_DRY_RUN_FIXTURES,
	UPGRADE_SCOPE_BOUNDARIES,
} from "../src/upgrade-preflight.js";

test("compatibility-input matrix covers every upgrade path class with all 11 fields", () => {
	const modes = COMPATIBILITY_INPUT_MATRIX.map((row) => row.deploymentMode);
	assert.deepEqual([...modes].sort(), [
		"data-shape",
		"hosted-control-plane",
		"local-dev-runtime",
		"sdk-package",
		"self-host-yard",
	]);
	for (const row of COMPATIBILITY_INPUT_MATRIX) {
		// Parsing is the proof: every row round-trips the 11-field input set.
		assert.deepEqual(parseCompatibilityInputs(row), row);
	}
});

test("compatibility inputs parse fails closed on missing fields", () => {
	assert.throws(
		() => parseCompatibilityInputs({ currentVersion: "1.0.0" }),
		/targetVersion/u,
	);
	assert.throws(
		() =>
			parseCompatibilityInputs({
				...COMPATIBILITY_INPUT_MATRIX[0],
				deploymentMode: "mainframe",
			}),
		/deploymentMode/u,
	);
});

test("rollback evidence refuses recoverable/available claims without concrete refs", () => {
	assert.throws(
		() =>
			parseRollbackEvidence({
				state: "available",
				immutableSetRef: null,
				snapshotRef: null,
				escalationOwner: "Support Workflow",
			}),
		/immutableSetRef or snapshotRef/u,
	);
	const evidence = parseRollbackEvidence({
		state: "recoverable",
		immutableSetRef: "deployment-set:local-dev:rev-12",
		snapshotRef: null,
		escalationOwner: "Support Workflow",
	});
	assert.equal(evidence.state, "recoverable");
});

test("scope-boundary register routes all six M0 scope-out categories", () => {
	assert.equal(UPGRADE_SCOPE_BOUNDARIES.length, 6);
	assert.throws(
		() => assertUpgradeScopeBoundary("execute live migration for tenant-a"),
		/routed to owning initiatives/u,
	);
	assert.throws(
		() => assertUpgradeScopeBoundary("run the rollback executor"),
		/routed to owning initiatives/u,
	);
	// Evidence requests stay in scope.
	assertUpgradeScopeBoundary("produce a dry-run report for self-host-yard");
	assert.equal(
		classifyUpgradeDryRunDecision("summarize compatibility inputs").inScope,
		true,
	);
});

test("dry-run fixtures produce the promoted decisions: passed / blocked / failed / passed", () => {
	const clean = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade);
	assert.equal(clean.status, "passed");
	assert.deepEqual(clean.blockedReasons, []);
	assert.deepEqual(clean.mutationCommands, []);

	const blocked = evaluateUpgradeDryRun(
		UPGRADE_DRY_RUN_FIXTURES.blockedUpgrade,
	);
	assert.equal(blocked.status, "blocked");
	assert.ok(
		blocked.blockedReasons.includes("contract-compatibility-unsupported"),
	);
	assert.ok(blocked.unsupportedPath);

	const failed = evaluateUpgradeDryRun(
		UPGRADE_DRY_RUN_FIXTURES.failedMigration,
	);
	assert.equal(failed.status, "failed");
	assert.equal(failed.rollbackEvidence.state, "required-before-execution");

	const rollbackReady = evaluateUpgradeDryRun(
		UPGRADE_DRY_RUN_FIXTURES.rollbackReady,
	);
	assert.equal(rollbackReady.status, "passed");
	assert.equal(rollbackReady.rollbackEvidence.state, "recoverable");
});

test("dry-run reports are deterministic (stable digest) and carry support handoff", () => {
	const first = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade);
	const second = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade);
	assert.equal(first.digest, second.digest);
	assert.equal(first.supportHandoff.owner, "Support Workflow");
	assert.ok(first.releaseNotes.requiredInputs.length >= 4);
});
