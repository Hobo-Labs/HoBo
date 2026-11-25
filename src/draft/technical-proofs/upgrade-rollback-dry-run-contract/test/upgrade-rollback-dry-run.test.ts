import assert from "node:assert/strict";
import { test } from "vitest";

import {
  UPGRADE_DRY_RUN_FIXTURES,
  classifyUpgradeDryRunDecision,
  evaluateUpgradeDryRun,
  stableDigest,
} from "../src/upgrade-rollback-dry-run.ts";

test("clean upgrade dry-run returns compatibility, backup, migration, rollback, release, and support evidence", () => {
  const report = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade);

  assert.equal(report.status, "passed");
  assert.equal(report.preflight.status, "passed");
  assert.equal(report.compatibility.result, "supported");
  assert.equal(report.backup.requirement, "required-and-satisfied");
  assert.deepEqual(
    report.migrationPlan.steps.map((step) => step.phase),
    ["expand", "backfill", "contract"],
  );
  assert.equal(report.rollbackEvidence.state, "available");
  assert.equal(report.releaseNotes.requiredInputs.length, 4);
  assert.equal(report.supportHandoff.owner, "Support Workflow");
  assert.equal(report.unsupportedPath, null);
});

test("blocked upgrade reports unsupported path without producing migration steps", () => {
  const report = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.blockedUpgrade);

  assert.equal(report.status, "blocked");
  assert.equal(report.preflight.status, "blocked");
  assert.equal(report.compatibility.result, "unsupported");
  assert.equal(report.unsupportedPath?.reason, "component-host-pin-below-floor");
  assert.deepEqual(report.migrationPlan.steps, []);
  assert.equal(report.releaseNotes.knownLimitation, "Self-host Yard 0.9.x cannot upgrade directly to 1.1.0.");
  assert.equal(report.supportHandoff.nextAction, "route-to-upgrade-support");
  assert.deepEqual(report.mutationCommands, []);
});

test("failed migration dry-run requires rollback evidence and support escalation without executing rollback", () => {
  const report = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.failedMigration);

  assert.equal(report.status, "failed");
  assert.equal(report.preflight.status, "failed");
  assert.equal(report.migrationPlan.failure?.reason, "contract-phase-would-drop-active-column");
  assert.equal(report.rollbackEvidence.state, "required-before-execution");
  assert.equal(report.rollbackEvidence.restorePrerequisite, "pre-migration-snapshot");
  assert.equal(report.supportHandoff.escalation, "release-owner-and-data-plane");
  assert.deepEqual(report.mutationCommands, []);
});

test("rollback fixture produces stable digest and recoverable rollback evidence", () => {
  const report = evaluateUpgradeDryRun(UPGRADE_DRY_RUN_FIXTURES.rollbackReady);
  const reordered = {
    targetVersion: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.targetVersion,
    sourceVersion: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.sourceVersion,
    id: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.id,
    deploymentMode: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.deploymentMode,
    support: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.support,
    releaseNotes: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.releaseNotes,
    rollback: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.rollback,
    migration: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.migration,
    backup: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.backup,
    compatibility: UPGRADE_DRY_RUN_FIXTURES.rollbackReady.compatibility,
  };

  assert.equal(report.status, "passed");
  assert.equal(report.rollbackEvidence.state, "recoverable");
  assert.equal(report.rollbackEvidence.immutableSetRef, "deployment-set:local-dev:rev-12");
  assert.equal(report.rollbackEvidence.snapshotRef, "snapshot:local-dev:pre-upgrade-1.0.0");
  assert.equal(report.digest, stableDigest(reordered));
});

test("scope guard rejects live migration and rollback execution creep", () => {
  assert.deepEqual(classifyUpgradeDryRunDecision("produce migration dry-run evidence"), {
    owner: "Upgrade & Migration Engine",
    inScope: true,
  });
  assert.deepEqual(classifyUpgradeDryRunDecision("execute the live migration runner"), {
    owner: "Out of scope",
    inScope: false,
  });
  assert.deepEqual(classifyUpgradeDryRunDecision("run rollback executor and rewrite provider state"), {
    owner: "Out of scope",
    inScope: false,
  });
  assert.deepEqual(classifyUpgradeDryRunDecision("open a support automation ticket"), {
    owner: "Out of scope",
    inScope: false,
  });
  assert.throws(
    () =>
      evaluateUpgradeDryRun({
        ...UPGRADE_DRY_RUN_FIXTURES.cleanUpgrade,
        requestedAction: "publish release notes and open support ticket",
      }),
    /dry-run contract does not execute/i,
  );
});
