import assert from "node:assert/strict";
import { test } from "vitest";

import {
  TENANT_DATA_LIFECYCLE_SCOPE,
  canCreateTenantDataFollowUp,
  classifyTenantDataLifecycleDecision,
  cloneMutableTenantDataLifecycleScope,
  validateTenantDataLifecycleScope,
} from "../src/tenant-data-lifecycle.ts";

test("M0 inventory records required tenant data classes and lifecycle fields", () => {
  const result = validateTenantDataLifecycleScope(TENANT_DATA_LIFECYCLE_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(TENANT_DATA_LIFECYCLE_SCOPE.issue, "HOBO-492");
  assert.equal(TENANT_DATA_LIFECYCLE_SCOPE.phase, "M0");
  assert.deepEqual(
    TENANT_DATA_LIFECYCLE_SCOPE.dataClasses.map((dataClass) => dataClass.id),
    [
      "customer-product-data",
      "telemetry",
      "logs",
      "generated-artifacts",
      "support-data",
      "billing-data",
      "audit-data",
    ],
  );
  assert.equal(
    TENANT_DATA_LIFECYCLE_SCOPE.dataClasses.every(
      (dataClass) =>
        dataClass.retention &&
        dataClass.deletionExportExpectation &&
        dataClass.residencySensitivity &&
        dataClass.owner &&
        dataClass.v1Limitation,
    ),
    true,
  );
});

test("deletion and account-closure obligations separate supported, manual, deferred, and impossible cases", () => {
  assert.deepEqual(
    TENANT_DATA_LIFECYCLE_SCOPE.deletionObligations.map((obligation) => obligation.id),
    [
      "supported-export",
      "supported-delete",
      "manual-review",
      "deferred-retention",
      "impossible-with-rationale",
    ],
  );
  assert.equal(
    TENANT_DATA_LIFECYCLE_SCOPE.deletionObligations.every(
      (obligation) => obligation.customerMessage && obligation.owner && obligation.auditEvidence,
    ),
    true,
  );
  assert.ok(
    TENANT_DATA_LIFECYCLE_SCOPE.deletionObligations.some((obligation) =>
      /legal retention/i.test(obligation.customerMessage),
    ),
  );
});

test("authoritative dependencies link legal/privacy, security, backup/restore, and support projects", () => {
  assert.deepEqual(TENANT_DATA_LIFECYCLE_SCOPE.designRefs, [
    "docs/design/legal-privacy-terms-readiness.md",
    "docs/design/security-verification.md",
    "docs/design/backup-restore.md",
    "docs/design/support-sla-channels.md",
    "docs/design/provenance-retention.md",
    "docs/design/tenant-isolation-quotas.md",
  ]);
  assert.ok(
    TENANT_DATA_LIFECYCLE_SCOPE.initiativeDependencies.some(
      (dependency) => dependency.owner === "Legal, Privacy & Terms Readiness",
    ),
  );
  assert.ok(
    TENANT_DATA_LIFECYCLE_SCOPE.initiativeDependencies.some(
      (dependency) => dependency.owner === "Security Verification",
    ),
  );
  assert.ok(
    TENANT_DATA_LIFECYCLE_SCOPE.initiativeDependencies.some(
      (dependency) => dependency.owner === "Backup & Restore",
    ),
  );
  assert.ok(
    TENANT_DATA_LIFECYCLE_SCOPE.initiativeDependencies.some(
      (dependency) => dependency.owner === "Support Workflow",
    ),
  );
});

test("M1 follow-up gate blocks lifecycle implementation until M0 acceptance", () => {
  assert.deepEqual(
    TENANT_DATA_LIFECYCLE_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "data-inventory-register",
      "retention-matrix",
      "deletion-export-obligation-fixture",
      "account-closure-routing",
      "residency-sensitivity-map",
      "support-assurance-handoff",
      "scope-boundary-register",
    ],
  );
  assert.equal(canCreateTenantDataFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateTenantDataFollowUp({ phase: "M3", m0Accepted: false }).allowed, false);
  assert.equal(canCreateTenantDataFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateTenantDataFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects lifecycle creep into legal approval, live deletion, storage, or customer data access", () => {
  const invalid = cloneMutableTenantDataLifecycleScope();
  invalid.scopeIn.push("Approve final DPA and legal privacy terms.");
  invalid.scopeIn.push("Implement live customer data deletion automation.");
  invalid.scopeIn.push("Build production storage retention and purge jobs.");
  invalid.scopeIn.push("Grant support direct production customer data access.");

  const result = validateTenantDataLifecycleScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /legal approval/i);
  assert.match(result.errors.join("\n"), /live deletion/i);
  assert.match(result.errors.join("\n"), /storage implementation/i);
  assert.match(result.errors.join("\n"), /customer data access/i);
});

test("decision classifier routes adjacent lifecycle work to owning initiatives", () => {
  assert.equal(
    classifyTenantDataLifecycleDecision("tenant data inventory retention and deletion matrix").owner,
    "Compliance Evidence Pack",
  );
  assert.equal(
    classifyTenantDataLifecycleDecision("final DPA legal terms and privacy policy approval").owner,
    "Legal, Privacy & Terms Readiness",
  );
  assert.equal(
    classifyTenantDataLifecycleDecision("security audit export and break-glass evidence").owner,
    "Security Verification",
  );
  assert.equal(
    classifyTenantDataLifecycleDecision("backup restore drill and recovery evidence").owner,
    "Backup & Restore",
  );
  assert.equal(
    classifyTenantDataLifecycleDecision("support ticket customer data access request").owner,
    "Support Workflow",
  );
});
