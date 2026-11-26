import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BACKUP_RESTORE_LAUNCH_DRILL,
  REQUIRED_CONTEXTS,
  canClaimProductionRestoreReadiness,
  classifyBackupRestoreGap,
  parseBackupRestoreLaunchDrill,
  validateBackupRestoreLaunchDrill,
} from "../src/backup-restore-launch-drill.ts";

test("launch drill names data sets, restore paths, RPO/RTO targets, evidence output, failure modes, and rollback paths", () => {
  const result = validateBackupRestoreLaunchDrill(BACKUP_RESTORE_LAUNCH_DRILL);

  assert.deepEqual(result.errors, []);
  assert.equal(BACKUP_RESTORE_LAUNCH_DRILL.issue, "HOBO-498");
  assert.equal(BACKUP_RESTORE_LAUNCH_DRILL.phase, "M1");
  assert.deepEqual(
    BACKUP_RESTORE_LAUNCH_DRILL.dataSets.map((dataSet) => dataSet.id),
    [
      "control-plane-metadata",
      "deployment-state-projections",
      "artifact-provenance",
      "audit-export",
      "support-bundle",
    ],
  );

  for (const path of BACKUP_RESTORE_LAUNCH_DRILL.restorePaths) {
    assert.ok(path.restoreTarget, path.id);
    assert.ok(path.rpoMinutes > 0, path.id);
    assert.ok(path.rtoMinutes > 0, path.id);
    assert.ok(path.evidenceOutput.fields.includes("measured-rpo-minutes"), path.id);
    assert.ok(path.evidenceOutput.fields.includes("measured-rto-minutes"), path.id);
    assert.ok(path.rollbackPath, path.id);
  }

  for (const mode of BACKUP_RESTORE_LAUNCH_DRILL.failureModes) {
    assert.ok(mode.requiredRouting, mode.id);
    assert.ok(mode.rollbackOrEscalation, mode.id);
  }
});

test("evidence distinguishes SaaS, self-host, and local/dev launch contexts", () => {
  assert.deepEqual(
    BACKUP_RESTORE_LAUNCH_DRILL.restorePaths.map((path) => path.context).sort(),
    [...REQUIRED_CONTEXTS].sort(),
  );

  const byContext = new Map(BACKUP_RESTORE_LAUNCH_DRILL.restorePaths.map((path) => [path.context, path]));
  assert.match(byContext.get("saas")?.evidenceSource ?? "", /hosted/i);
  assert.match(byContext.get("self-host")?.evidenceSource ?? "", /operator/i);
  assert.match(byContext.get("local-dev")?.evidenceSource ?? "", /fixture/i);
});

test("gaps route to support, compliance, installation, or release notes without expanding backup scope", () => {
  assert.deepEqual(classifyBackupRestoreGap("customer restore ticket needs owner"), {
    owner: "Launch Support & Escalation",
    inScope: false,
  });
  assert.deepEqual(classifyBackupRestoreGap("DPA evidence and compliance approval missing"), {
    owner: "Customer Assurance / Legal Privacy",
    inScope: false,
  });
  assert.equal(classifyBackupRestoreGap("self-host installer backup hook").owner, "Bootstrap Installer");
  assert.equal(classifyBackupRestoreGap("upgrade guide limitation note").owner, "Release Notes & Upgrade Guide");
  assert.equal(classifyBackupRestoreGap("deterministic drill evidence fixture").inScope, true);
});

test("production restore readiness cannot be claimed without successful drill evidence", () => {
  assert.equal(
    canClaimProductionRestoreReadiness({
      successfulDrillEvidence: false,
      usesLiveCustomerData: false,
    }).allowed,
    false,
  );
  assert.equal(
    canClaimProductionRestoreReadiness({
      successfulDrillEvidence: true,
      usesLiveCustomerData: true,
    }).allowed,
    false,
  );
  assert.equal(
    canClaimProductionRestoreReadiness({
      successfulDrillEvidence: true,
      usesLiveCustomerData: false,
    }).allowed,
    true,
  );
});

test("scope guard rejects production restore service and live-customer-data creep", () => {
  const invalid = {
    ...BACKUP_RESTORE_LAUNCH_DRILL,
    scopeIn: [
      ...BACKUP_RESTORE_LAUNCH_DRILL.scopeIn,
      "Build the production restore service and wire live customer restore execution.",
      "Provision cloud backup storage and snapshot scheduling.",
      "Use live customer data to prove customer recovery.",
    ],
  };

  const result = validateBackupRestoreLaunchDrill(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /production restore/i);
  assert.match(result.errors.join("\n"), /backup storage/i);
  assert.match(result.errors.join("\n"), /live customer data/i);
});

test("parser returns a derived launch drill record or explicit errors at the boundary", () => {
  const parsed = parseBackupRestoreLaunchDrill(BACKUP_RESTORE_LAUNCH_DRILL);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.issue : undefined, "HOBO-498");

  const rejected = parseBackupRestoreLaunchDrill({ issue: "HOBO-498", phase: "M1" });

  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? "" : rejected.errors.join("\n"), /Missing backup\/restore data set/);
});
