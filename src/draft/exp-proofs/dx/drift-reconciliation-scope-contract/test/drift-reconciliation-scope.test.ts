import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DRIFT_RECONCILIATION_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateDriftReconciliationFollowUp,
  classifyDriftReconciliationDecision,
  validateDriftReconciliationScope,
} from "../src/drift-reconciliation-scope.ts";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(DRIFT_RECONCILIATION_SCOPE.issue, "HOBO-442");
  assert.equal(DRIFT_RECONCILIATION_SCOPE.project, "Drift Reconciliation");
  assert.equal(DRIFT_RECONCILIATION_SCOPE.phase, "M0");
  assert.match(DRIFT_RECONCILIATION_SCOPE.goal, /drift reconciliation/i);
  assert.match(DRIFT_RECONCILIATION_SCOPE.goal, /source of truth/i);
  assert.deepEqual(
    DRIFT_RECONCILIATION_SCOPE.personas.map((persona) => persona.id),
    ["platform-engineer", "sre-operator", "support-operator", "security-reviewer"],
  );
  assert.deepEqual(
    DRIFT_RECONCILIATION_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(DRIFT_RECONCILIATION_SCOPE.scopeIn.some((item) => /drift classes/i.test(item)));
  assert.ok(DRIFT_RECONCILIATION_SCOPE.scopeOut.some((item) => /provider refresh scheduler/i.test(item)));
  assert.ok(DRIFT_RECONCILIATION_SCOPE.nonGoals.some((item) => /autonomous remediation/i.test(item)));
});

test("M0 dependencies map authoritative design sources and owning initiatives", () => {
  assert.ok(DRIFT_RECONCILIATION_SCOPE.designRefs.includes("docs/design/control-plane.md#plan-04"));
  assert.ok(
    DRIFT_RECONCILIATION_SCOPE.designRefs.includes(
      "docs/design/reliability-observability-cost.md#plan-05",
    ),
  );
  assert.ok(DRIFT_RECONCILIATION_SCOPE.designRefs.includes("docs/design/operators-sre.md#plan-40"));
  assert.ok(
    DRIFT_RECONCILIATION_SCOPE.adrRefs.includes(
      "docs/design/adr/01-architecture-core.md#adr-0004",
    ),
  );
  assert.ok(
    DRIFT_RECONCILIATION_SCOPE.adrRefs.includes(
      "docs/design/adr/03-data-plane.md#adr-0058",
    ),
  );
  assert.ok(
    DRIFT_RECONCILIATION_SCOPE.initiativeDependencies.some(
      (dependency) =>
        dependency.owner === "Resource Garbage Collection" &&
        /garbage eligibility/i.test(dependency.boundary),
    ),
  );
});

test("drift classes, reconciliation states, and evidence fields are explicit", () => {
  assert.deepEqual(
    DRIFT_RECONCILIATION_SCOPE.driftClasses.map((entry) => entry.id),
    [
      "observed-state-diff",
      "missing-provider-resource",
      "extra-provider-resource",
      "configuration-divergence",
      "adopted-resource-drift",
      "stale-observation",
    ],
  );
  assert.deepEqual(
    DRIFT_RECONCILIATION_SCOPE.reconciliationStates.map((state) => state.id),
    [
      "detected",
      "classified",
      "source-of-truth-pinned",
      "proposed",
      "reconciling",
      "ignored",
      "escalated",
      "resolved",
    ],
  );
  assert.deepEqual(
    DRIFT_RECONCILIATION_SCOPE.requiredEvidence.map((field) => field.id),
    [
      "resource-identity",
      "desired-state-ref",
      "observed-state-ref",
      "source-of-truth",
      "last-refresh",
      "policy-decision",
      "support-handoff",
    ],
  );
});

test("M1 evidence gate blocks follow-up design and implementation issues until M0 is accepted", () => {
  assert.deepEqual(
    DRIFT_RECONCILIATION_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "drift-report-schema",
      "source-of-truth-fixture",
      "reconciliation-decision-state-machine",
      "resourceactor-handoff-fixture",
      "garbage-collection-handoff",
      "support-export-contract",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    canCreateDriftReconciliationFollowUp({ phase: "M1", m0Accepted: false }).allowed,
    false,
  );
  assert.equal(
    canCreateDriftReconciliationFollowUp({ phase: "M1", m0Accepted: true }).allowed,
    true,
  );
  assert.equal(
    canCreateDriftReconciliationFollowUp({ phase: "M0", m0Accepted: false }).allowed,
    true,
  );
});

test("scope validation rejects provider, runtime, remediation, cleanup, support, and billing creep", () => {
  assert.deepEqual(validateDriftReconciliationScope(DRIFT_RECONCILIATION_SCOPE), {
    ok: true,
    errors: [],
  });

  const providerCreep = validateDriftReconciliationScope({
    ...DRIFT_RECONCILIATION_SCOPE,
    scopeIn: [
      ...DRIFT_RECONCILIATION_SCOPE.scopeIn,
      "Implement the provider refresh scheduler for live Azure resources.",
    ],
  });
  assert.equal(providerCreep.ok, false);
  assert.match(providerCreep.errors.join("\n"), /provider/i);

  const runtimeCreep = validateDriftReconciliationScope({
    ...DRIFT_RECONCILIATION_SCOPE,
    scopeIn: [
      ...DRIFT_RECONCILIATION_SCOPE.scopeIn,
      "Change ResourceActor reconcile runtime behavior after a diff is detected.",
    ],
  });
  assert.equal(runtimeCreep.ok, false);
  assert.match(runtimeCreep.errors.join("\n"), /runtime/i);

  const remediationCreep = validateDriftReconciliationScope({
    ...DRIFT_RECONCILIATION_SCOPE,
    scopeIn: [
      ...DRIFT_RECONCILIATION_SCOPE.scopeIn,
      "Ship autonomous remediation that mutates real cloud resources.",
    ],
  });
  assert.equal(remediationCreep.ok, false);
  assert.match(remediationCreep.errors.join("\n"), /remediation/i);

  const cleanupCreep = validateDriftReconciliationScope({
    ...DRIFT_RECONCILIATION_SCOPE,
    scopeIn: [
      ...DRIFT_RECONCILIATION_SCOPE.scopeIn,
      "Run a garbage sweeper that performs destructive cleanup for extra resources.",
    ],
  });
  assert.equal(cleanupCreep.ok, false);
  assert.match(cleanupCreep.errors.join("\n"), /cleanup/i);

  const supportCreep = validateDriftReconciliationScope({
    ...DRIFT_RECONCILIATION_SCOPE,
    scopeIn: [...DRIFT_RECONCILIATION_SCOPE.scopeIn, "Build support ticketing for drift cases."],
  });
  assert.equal(supportCreep.ok, false);
  assert.match(supportCreep.errors.join("\n"), /support/i);

  const billingCreep = validateDriftReconciliationScope({
    ...DRIFT_RECONCILIATION_SCOPE,
    scopeIn: [...DRIFT_RECONCILIATION_SCOPE.scopeIn, "Apply billing adjustment after drift repair."],
  });
  assert.equal(billingCreep.ok, false);
  assert.match(billingCreep.errors.join("\n"), /billing/i);

  const missingSourceOfTruth = validateDriftReconciliationScope({
    ...DRIFT_RECONCILIATION_SCOPE,
    requiredEvidence: DRIFT_RECONCILIATION_SCOPE.requiredEvidence.filter(
      (field) => field.id !== "source-of-truth",
    ),
  });
  assert.equal(missingSourceOfTruth.ok, false);
  assert.match(missingSourceOfTruth.errors.join("\n"), /source-of-truth/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyDriftReconciliationDecision("classify observed-state diff evidence"), {
    owner: "Drift Reconciliation",
    inScope: true,
  });
  assert.equal(
    classifyDriftReconciliationDecision("provider refresh scheduler polls live Azure APIs").owner,
    "Providers, IaC & Build Adapters",
  );
  assert.equal(
    classifyDriftReconciliationDecision("ResourceActor reconcile command applies the diff").owner,
    "Control Plane: Planner, Matching & Orchestrator",
  );
  assert.equal(
    classifyDriftReconciliationDecision("garbage eligibility for extra provider resources").owner,
    "Resource Garbage Collection",
  );
  assert.equal(
    classifyDriftReconciliationDecision("support ticket escalation for unresolved drift").owner,
    "Support Workflow",
  );
  assert.equal(
    classifyDriftReconciliationDecision("billing adjustment after drift").owner,
    "Usage Metering",
  );
});
