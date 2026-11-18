import assert from "node:assert/strict";
import { test } from "vitest";

import {
	assertUpgradeScopeBoundary,
	COMPATIBILITY_INPUT_MATRIX,
	classifyUpgradeDryRunDecision,
	evaluateUpgradeDryRun,
	parseCompatibilityInputs,
	parseRollbackEvidence,
	parseUpgradeDryRunRequest,
	UPGRADE_DRY_RUN_ACTION,
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
		assert.deepEqual(parseCompatibilityInputs({ ...row }), row);
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
	assertUpgradeScopeBoundary(UPGRADE_DRY_RUN_ACTION);
	assert.equal(
		classifyUpgradeDryRunDecision(UPGRADE_DRY_RUN_ACTION).inScope,
		true,
	);
	for (const action of [
		"",
		"delete customer data",
		"remove all backups",
		"summarize compatibility inputs",
	]) {
		assert.equal(classifyUpgradeDryRunDecision(action).inScope, false);
		assert.throws(
			() => assertUpgradeScopeBoundary(action),
			/routed to owning initiatives/u,
		);
	}
});

test("the dry-run entry point rejects an unrecognized requested action", () => {
	for (const action of ["delete customer data", "", null]) {
		const request = JSON.parse(
			JSON.stringify({ ...UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade, action }),
		);
		assert.throws(() => evaluateUpgradeDryRun(request), /requestedAction/u);
	}
});

test("dry-run fixtures produce the promoted decisions: passed / blocked / failed / passed", () => {
	const clean = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade);
	assert.equal(clean.status, "passed");
	assert.deepEqual(clean.blockedReasons, []);
	assert.deepEqual(clean.mutationCommands, []);
	assert.deepEqual(
		clean.migrationPlan.steps.map((step) => step.phase),
		["expand", "backfill", "contract"],
	);

	const blocked = evaluateUpgradeDryRun(
		UPGRADE_DRY_RUN_FIXTURES.blockedUpgrade,
	);
	assert.equal(blocked.status, "blocked");
	assert.ok(
		blocked.blockedReasons.includes("contract-compatibility-unsupported"),
	);
	assert.ok(blocked.unsupportedPath);
	assert.equal(
		blocked.unsupportedPath.reason,
		"component-host-pin-below-floor",
	);
	assert.equal(blocked.supportHandoff.nextAction, "route-to-upgrade-support");

	const failed = evaluateUpgradeDryRun(
		UPGRADE_DRY_RUN_FIXTURES.failedMigration,
	);
	assert.equal(failed.status, "failed");
	assert.equal(
		failed.migrationPlan.failure?.reason,
		"contract-phase-would-drop-active-column",
	);
	assert.equal(failed.rollbackEvidence.state, "required-before-execution");
	assert.equal(
		failed.rollbackEvidence.restorePrerequisite,
		"pre-migration-snapshot",
	);
	assert.equal(
		failed.supportHandoff.escalation,
		"release-owner-and-data-plane",
	);

	const rollbackReady = evaluateUpgradeDryRun(
		UPGRADE_DRY_RUN_FIXTURES.rollbackReady,
	);
	assert.equal(rollbackReady.status, "passed");
	assert.equal(rollbackReady.rollbackEvidence.state, "recoverable");
	assert.equal(
		rollbackReady.rollbackEvidence.snapshotRef,
		"snapshot:local-dev:pre-upgrade-1.0.0",
	);
});

test("dry-run reports are deterministic (stable digest) and carry support handoff", () => {
	const first = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade);
	const second = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade);
	assert.equal(first.digest, second.digest);
	assert.equal(first.supportHandoff.owner, "Support Workflow");
	assert.ok(first.releaseNotes.requiredInputs.length >= 4);
});

test("unresolved compatibility blocks a dry run without exposing migration steps", () => {
	for (const compatibility of ["needs-review", "unsupported"] as const) {
		const request = {
			...UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade,
			compatibility: {
				...UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade.compatibility,
				contractCompatibility: compatibility,
			},
		};
		const report = evaluateUpgradeDryRun(request);
		assert.equal(report.status, "blocked");
		assert.ok(
			report.blockedReasons.includes(`contract-compatibility-${compatibility}`),
		);
		assert.deepEqual(report.migrationPlan.steps, []);
	}
});

test("contract work requires available rollback evidence", () => {
	const request = {
		...UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade,
		rollback: {
			state: "unavailable" as const,
			immutableSetRef: null,
			snapshotRef: null,
			escalationOwner: "Support Workflow",
		},
	};
	const report = evaluateUpgradeDryRun(request);
	assert.equal(report.status, "blocked");
	assert.ok(report.blockedReasons.includes("rollback-evidence-unavailable"));
	assert.deepEqual(report.migrationPlan.steps, []);
});

test("reports hold an immutable copy of the supplied evidence", () => {
	const sample = UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade;
	const steps = [{ phase: "expand" as const, summary: "Add a column" }];
	const compatibility = { ...sample.compatibility };
	const rollback = { ...sample.rollback };
	const requiredInputs = ["rollback-guidance"];
	const support = { owner: "Support Workflow", handoff: "Share the report" };
	const report = evaluateUpgradeDryRun({
		id: "upgrade",
		compatibility,
		migration: { steps },
		rollback,
		releaseNotes: { requiredInputs },
		support,
	});
	const digest = report.digest;
	const step = steps[0];
	if (!step) throw new Error("expected a migration step");
	step.summary = "changed";
	compatibility.currentVersion = "changed";
	rollback.immutableSetRef = "changed";
	requiredInputs.push("changed");
	support.handoff = "changed";
	assert.equal(report.migrationPlan.steps[0]?.summary, "Add a column");
	assert.equal(
		report.compatibility.currentVersion,
		sample.compatibility.currentVersion,
	);
	assert.equal(
		report.rollbackEvidence.immutableSetRef,
		sample.rollback.immutableSetRef,
	);
	assert.deepEqual(report.releaseNotes.requiredInputs, ["rollback-guidance"]);
	assert.equal(report.supportHandoff.handoff, "Share the report");
	assert.equal(report.digest, digest);
	assert.ok(Object.isFrozen(report.migrationPlan.steps[0]));
});

test("dry-run requests reject invalid or out-of-order migration phases", () => {
	const request = JSON.parse(
		JSON.stringify(UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade),
	);
	request.migration.steps[0].phase = "unknown";
	assert.throws(
		() => parseUpgradeDryRunRequest(request),
		/migration\.steps\[0\]\.phase/u,
	);
	request.migration.steps[0].phase = "contract";
	assert.throws(
		() => parseUpgradeDryRunRequest(request),
		/phases in expand, backfill, contract order/u,
	);
});

test("dry-run requests reject fields that would be silently ignored", () => {
	const request = {
		...UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade,
		requestedAction: "execute live migration",
	};
	assert.throws(() => evaluateUpgradeDryRun(request), /requestedAction/u);
});
