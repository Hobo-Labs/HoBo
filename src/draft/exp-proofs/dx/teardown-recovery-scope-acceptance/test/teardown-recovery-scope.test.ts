import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_BOUNDARIES,
  TEARDOWN_RECOVERY_SCOPE,
  canCreateTeardownRecoveryFollowUp,
  classifyTeardownRecoveryDecision,
  validateTeardownRecoveryScope,
} from "../src/teardown-recovery-scope.ts";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(TEARDOWN_RECOVERY_SCOPE.issue, "HOBO-444");
  assert.equal(TEARDOWN_RECOVERY_SCOPE.project, "Teardown & Recovery");
  assert.equal(TEARDOWN_RECOVERY_SCOPE.phase, "M0");
  assert.match(TEARDOWN_RECOVERY_SCOPE.goal, /teardown and recovery/i);
  assert.match(TEARDOWN_RECOVERY_SCOPE.goal, /safe teardown/i);
  assert.deepEqual(
    TEARDOWN_RECOVERY_SCOPE.personas.map((persona) => persona.id),
    ["platform-engineer", "sre-operator", "support-operator", "security-reviewer", "customer-admin"],
  );
  assert.deepEqual(
    TEARDOWN_RECOVERY_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(TEARDOWN_RECOVERY_SCOPE.scopeIn.some((item) => /teardown states/i.test(item)));
  assert.ok(TEARDOWN_RECOVERY_SCOPE.scopeOut.some((item) => /live provider/i.test(item)));
  assert.ok(TEARDOWN_RECOVERY_SCOPE.nonGoals.some((item) => /production teardown/i.test(item)));
});

test("M0 dependencies map authoritative design sources and owning initiatives", () => {
  assert.deepEqual(TEARDOWN_RECOVERY_SCOPE.designRefs, [
    "docs/design/control-plane.md#plan-04",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/environment-lifecycle.md",
    "docs/design/resource-garbage-collection.md",
    "docs/design/backup-restore.md",
    "docs/design/upgrade-migration-engine.md",
    "docs/design/support-sla-channels.md",
  ]);
  assert.deepEqual(TEARDOWN_RECOVERY_SCOPE.adrRefs, [
    "docs/design/adr/01-architecture-core.md#adr-0004",
    "docs/design/adr/01-architecture-core.md#adr-0006",
    "docs/design/adr/03-data-plane.md#adr-0058",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
    "docs/design/adr/02-identity-security.md#adr-0094",
  ]);
  assert.deepEqual(
    TEARDOWN_RECOVERY_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Teardown & Recovery",
      "Environment Lifecycle",
      "Resource Garbage Collection",
      "Backup & Restore",
      "Upgrade & Migration Engine",
      "Support Workflow",
      "Control Plane: Planner, Matching & Orchestrator",
      "Contracts, Policy & Governance",
    ],
  );
});

test("teardown states, recovery states, and evidence fields are explicit", () => {
  assert.deepEqual(
    TEARDOWN_RECOVERY_SCOPE.teardownStates.map((state) => state.id),
    ["requested", "blocked", "draining", "teardown-ready", "recoverable", "terminal", "escalated"],
  );
  assert.deepEqual(
    TEARDOWN_RECOVERY_SCOPE.recoveryModes.map((mode) => mode.id),
    ["resume", "rollback", "restore-from-evidence", "manual-escalation"],
  );
  assert.deepEqual(
    TEARDOWN_RECOVERY_SCOPE.requiredEvidence.map((field) => field.id),
    [
      "owner",
      "scope",
      "last-known-state",
      "dependency-drain",
      "backup-or-rollback-reference",
      "cleanup-handoff",
      "support-handoff",
      "policy-decision",
    ],
  );
});

test("M1 evidence gate blocks follow-up implementation issues until M0 is accepted", () => {
  assert.deepEqual(
    TEARDOWN_RECOVERY_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "teardown-state-schema",
      "dependency-drain-matrix",
      "recovery-decision-table",
      "cleanup-handoff-fixture",
      "support-escalation-export",
      "scope-boundary-register",
    ],
  );
  assert.equal(canCreateTeardownRecoveryFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateTeardownRecoveryFollowUp({ phase: "M2", m0Accepted: false }).allowed, false);
  assert.equal(canCreateTeardownRecoveryFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateTeardownRecoveryFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects live teardown, provider mutation, restore runtime, billing, and support tooling creep", () => {
  assert.deepEqual(validateTeardownRecoveryScope(TEARDOWN_RECOVERY_SCOPE), {
    ok: true,
    errors: [],
  });

  const providerCreep = validateTeardownRecoveryScope({
    ...TEARDOWN_RECOVERY_SCOPE,
    scopeIn: [
      ...TEARDOWN_RECOVERY_SCOPE.scopeIn,
      "Implement live provider deletes and real AWS resource teardown.",
    ],
  });
  assert.equal(providerCreep.ok, false);
  assert.match(providerCreep.errors.join("\n"), /provider/i);

  const runtimeCreep = validateTeardownRecoveryScope({
    ...TEARDOWN_RECOVERY_SCOPE,
    scopeIn: [
      ...TEARDOWN_RECOVERY_SCOPE.scopeIn,
      "Ship production teardown runner, restore runtime, and mutate live environments.",
    ],
  });
  assert.equal(runtimeCreep.ok, false);
  assert.match(runtimeCreep.errors.join("\n"), /runtime/i);

  const billingCreep = validateTeardownRecoveryScope({
    ...TEARDOWN_RECOVERY_SCOPE,
    scopeIn: [...TEARDOWN_RECOVERY_SCOPE.scopeIn, "Calculate refunds, invoices, and chargebacks for teardown."],
  });
  assert.equal(billingCreep.ok, false);
  assert.match(billingCreep.errors.join("\n"), /billing/i);

  const missingBackupReference = validateTeardownRecoveryScope({
    ...TEARDOWN_RECOVERY_SCOPE,
    requiredEvidence: TEARDOWN_RECOVERY_SCOPE.requiredEvidence.filter(
      (field) => field.id !== "backup-or-rollback-reference",
    ),
  });
  assert.equal(missingBackupReference.ok, false);
  assert.match(missingBackupReference.errors.join("\n"), /backup-or-rollback-reference/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyTeardownRecoveryDecision("define teardown state evidence for a project"), {
    owner: "Teardown & Recovery",
    inScope: true,
  });
  assert.equal(
    classifyTeardownRecoveryDecision("provider adapter deletes real Azure resources").owner,
    "Providers, IaC & Build Adapters",
  );
  assert.equal(
    classifyTeardownRecoveryDecision("backup restore drill and RPO proof").owner,
    "Backup & Restore",
  );
  assert.equal(
    classifyTeardownRecoveryDecision("resource garbage cleanup sweeper").owner,
    "Resource Garbage Collection",
  );
  assert.equal(
    classifyTeardownRecoveryDecision("support ticket queue and SLA automation").owner,
    "Support Workflow",
  );
});
