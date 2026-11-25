import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BACKUP_RESTORE_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateBackupRestoreFollowUp,
  classifyBackupRestoreDecision,
  validateBackupRestoreScope,
} from "../src/backup-restore-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateBackupRestoreScope(BACKUP_RESTORE_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(BACKUP_RESTORE_SCOPE.issue, "HOBO-429");
  assert.equal(BACKUP_RESTORE_SCOPE.project, "Backup & Restore");
  assert.equal(BACKUP_RESTORE_SCOPE.phase, "M0");
  assert.match(BACKUP_RESTORE_SCOPE.goal, /backup and restore/i);
  assert.match(BACKUP_RESTORE_SCOPE.goal, /rpo/i);
  assert.match(BACKUP_RESTORE_SCOPE.goal, /rto/i);
  assert.deepEqual(
    BACKUP_RESTORE_SCOPE.personas.map((persona) => persona.role),
    [
      "platform engineer",
      "sre operator",
      "support engineer",
      "security/compliance reviewer",
      "customer admin",
    ],
  );
  assert.deepEqual(Object.keys(BACKUP_RESTORE_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(BACKUP_RESTORE_SCOPE.scopeIn.length >= 5);
  assert.ok(BACKUP_RESTORE_SCOPE.scopeOut.length >= 6);
  assert.ok(BACKUP_RESTORE_SCOPE.nonGoals.some((item) => /production restore/i.test(item)));
});

test("M0 dependencies map authoritative design sources", () => {
  assert.deepEqual(
    BACKUP_RESTORE_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/reliability-observability-cost.md#plan-05",
      "docs/design/data-plane.md#plan-11",
      "docs/design/provenance-retention.md",
      "docs/design/bootstrap-installer.md",
      "docs/design/launch-support-escalation.md",
      "docs/design/adr/02-identity-security.md#adr-0082",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking adjacent scope", () => {
  assert.deepEqual(
    BACKUP_RESTORE_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Backup & Restore",
      "Provenance & Retention",
      "Upgrade & Migration Engine",
      "Support Workflow",
      "Compliance Evidence Pack",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    BACKUP_RESTORE_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    BACKUP_RESTORE_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "backup-source-inventory",
      "restore-path-matrix",
      "rpo-rto-drill-fixture",
      "failure-mode-recovery-register",
      "support-compliance-handoff",
      "rollback-cleanup-boundary",
    ],
  );
  assert.equal(
    BACKUP_RESTORE_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateBackupRestoreFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateBackupRestoreFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateBackupRestoreFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateBackupRestoreFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects storage, restore, live data, compliance, or scheduler creep", () => {
  const result = validateBackupRestoreScope({
    ...BACKUP_RESTORE_SCOPE,
    scopeIn: [
      ...BACKUP_RESTORE_SCOPE.scopeIn,
      "Implement production backup storage, live customer restore execution, cross-region scheduler, and compliance approval.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("decision classifier routes adjacent work to the right owning initiative", () => {
  assert.deepEqual(classifyBackupRestoreDecision("define restore path matrix for RPO evidence"), {
    owner: "Backup & Restore",
    inScope: true,
  });
  assert.equal(
    classifyBackupRestoreDecision("upgrade rollback migration dry run").owner,
    "Upgrade & Migration Engine",
  );
  assert.equal(
    classifyBackupRestoreDecision("retention class for release artifact provenance").owner,
    "Provenance & Retention",
  );
  assert.equal(
    classifyBackupRestoreDecision("support ticket escalation after failed restore").owner,
    "Support Workflow",
  );
  assert.equal(
    classifyBackupRestoreDecision("customer assurance DPA approval for backup location").owner,
    "Compliance Evidence Pack",
  );
});

test("scope validation requires proof source for backup evidence claims", () => {
  const result = validateBackupRestoreScope({
    ...BACKUP_RESTORE_SCOPE,
    m1Evidence: [
      ...BACKUP_RESTORE_SCOPE.m1Evidence,
      {
        kind: "restore-ready-claim",
        owner: "sre operator",
        proofMode: "drill-fixture",
        proves: "Restore is ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /source/i);
});
