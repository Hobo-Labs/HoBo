import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RESOURCE_GARBAGE_COLLECTION_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateResourceGarbageCollectionFollowUp,
  classifyResourceGarbageCollectionDecision,
  validateResourceGarbageCollectionScope,
} from "../src/resource-garbage-collection-scope.ts";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(RESOURCE_GARBAGE_COLLECTION_SCOPE.issue, "HOBO-443");
  assert.equal(RESOURCE_GARBAGE_COLLECTION_SCOPE.project, "Resource Garbage Collection");
  assert.equal(RESOURCE_GARBAGE_COLLECTION_SCOPE.phase, "M0");
  assert.match(RESOURCE_GARBAGE_COLLECTION_SCOPE.goal, /garbage collection/i);
  assert.match(RESOURCE_GARBAGE_COLLECTION_SCOPE.goal, /safe cleanup/i);
  assert.deepEqual(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.personas.map((persona) => persona.id),
    ["platform-engineer", "sre-operator", "support-operator", "security-reviewer"],
  );
  assert.deepEqual(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.scopeIn.some((item) => /orphan inventory/i.test(item)),
  );
  assert.ok(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.scopeOut.some((item) => /provider adapter/i.test(item)),
  );
  assert.ok(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.nonGoals.some((item) => /replace drift/i.test(item)),
  );
});

test("M0 dependencies map authoritative design sources and owning initiatives", () => {
  assert.ok(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.designRefs.includes("docs/design/control-plane.md#plan-04"),
  );
  assert.ok(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.designRefs.includes(
      "docs/design/reliability-observability-cost.md#plan-05",
    ),
  );
  assert.ok(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.adrRefs.includes(
      "docs/design/adr/01-architecture-core.md#adr-0006",
    ),
  );
  assert.ok(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.adrRefs.includes(
      "docs/design/adr/03-data-plane.md#adr-0058",
    ),
  );
  assert.ok(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.initiativeDependencies.some(
      (dependency) =>
        dependency.owner === "Drift Reconciliation" && /drift report/i.test(dependency.boundary),
    ),
  );
});

test("garbage classes, terminal states, and evidence fields are explicit", () => {
  assert.deepEqual(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.garbageClasses.map((entry) => entry.id),
    [
      "created-but-not-in-state",
      "destroyed-in-state-but-live",
      "deprecated-generated-artifact",
      "expired-preview-resource",
      "failed-cleanup-residue",
    ],
  );
  assert.deepEqual(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.cleanupStates.map((state) => state.id),
    ["suspected", "inventoried", "quarantined", "eligible", "swept", "escalated"],
  );
  assert.deepEqual(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.requiredEvidence.map((field) => field.id),
    [
      "owner",
      "resource-identity",
      "source-of-truth",
      "last-observed",
      "eligibility-decision",
      "policy-window",
      "support-handoff",
    ],
  );
});

test("M1 evidence gate blocks follow-up implementation issues until M0 is accepted", () => {
  assert.deepEqual(
    RESOURCE_GARBAGE_COLLECTION_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "garbage-inventory-schema",
      "cleanup-eligibility-state-machine",
      "drift-orphan-handoff",
      "policy-retention-window-fixture",
      "support-escalation-export",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    canCreateResourceGarbageCollectionFollowUp({ phase: "M1", m0Accepted: false }).allowed,
    false,
  );
  assert.equal(
    canCreateResourceGarbageCollectionFollowUp({ phase: "M1", m0Accepted: true }).allowed,
    true,
  );
  assert.equal(
    canCreateResourceGarbageCollectionFollowUp({ phase: "M0", m0Accepted: false }).allowed,
    true,
  );
});

test("scope validation rejects provider, live delete, billing, and retention implementation creep", () => {
  assert.deepEqual(validateResourceGarbageCollectionScope(RESOURCE_GARBAGE_COLLECTION_SCOPE), {
    ok: true,
    errors: [],
  });

  const providerCreep = validateResourceGarbageCollectionScope({
    ...RESOURCE_GARBAGE_COLLECTION_SCOPE,
    scopeIn: [
      ...RESOURCE_GARBAGE_COLLECTION_SCOPE.scopeIn,
      "Implement a provider adapter sweeper for live cloud deletes.",
    ],
  });
  assert.equal(providerCreep.ok, false);
  assert.match(providerCreep.errors.join("\n"), /provider/i);

  const runtimeCreep = validateResourceGarbageCollectionScope({
    ...RESOURCE_GARBAGE_COLLECTION_SCOPE,
    scopeIn: [
      ...RESOURCE_GARBAGE_COLLECTION_SCOPE.scopeIn,
      "Ship the production cleanup daemon and mutate real resource state.",
    ],
  });
  assert.equal(runtimeCreep.ok, false);
  assert.match(runtimeCreep.errors.join("\n"), /runtime/i);

  const retentionCreep = validateResourceGarbageCollectionScope({
    ...RESOURCE_GARBAGE_COLLECTION_SCOPE,
    scopeIn: [
      ...RESOURCE_GARBAGE_COLLECTION_SCOPE.scopeIn,
      "Define legal retention deletion policy for all customer data.",
    ],
  });
  assert.equal(retentionCreep.ok, false);
  assert.match(retentionCreep.errors.join("\n"), /retention/i);

  const missingPolicyWindow = validateResourceGarbageCollectionScope({
    ...RESOURCE_GARBAGE_COLLECTION_SCOPE,
    requiredEvidence: RESOURCE_GARBAGE_COLLECTION_SCOPE.requiredEvidence.filter(
      (field) => field.id !== "policy-window",
    ),
  });
  assert.equal(missingPolicyWindow.ok, false);
  assert.match(missingPolicyWindow.errors.join("\n"), /policy-window/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyResourceGarbageCollectionDecision("classify orphan inventory evidence"), {
    owner: "Resource Garbage Collection",
    inScope: true,
  });
  assert.equal(
    classifyResourceGarbageCollectionDecision("provider adapter sweeps real Azure resources").owner,
    "Providers, IaC & Build Adapters",
  );
  assert.equal(
    classifyResourceGarbageCollectionDecision("drift detection refresh loop").owner,
    "Drift Reconciliation",
  );
  assert.equal(
    classifyResourceGarbageCollectionDecision("support ticket escalation for unreclaimed residue")
      .owner,
    "Support Workflow",
  );
  assert.equal(
    classifyResourceGarbageCollectionDecision("billing chargeback after cleanup").owner,
    "Usage Metering",
  );
});
