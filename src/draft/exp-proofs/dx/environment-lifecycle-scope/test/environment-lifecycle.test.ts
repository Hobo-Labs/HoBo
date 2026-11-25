import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ENVIRONMENT_LIFECYCLE_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateEnvironmentLifecycleFollowUp,
  classifyEnvironmentLifecycleDecision,
  validateEnvironmentLifecycleScope,
} from "../src/environment-lifecycle.ts";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(ENVIRONMENT_LIFECYCLE_SCOPE.issue, "HOBO-414");
  assert.equal(ENVIRONMENT_LIFECYCLE_SCOPE.project, "Environment Lifecycle");
  assert.equal(ENVIRONMENT_LIFECYCLE_SCOPE.phase, "M0");
  assert.match(ENVIRONMENT_LIFECYCLE_SCOPE.goal, /environment lifecycle/i);
  assert.match(ENVIRONMENT_LIFECYCLE_SCOPE.goal, /scope and acceptance/i);
  assert.deepEqual(
    ENVIRONMENT_LIFECYCLE_SCOPE.personas.map((persona) => persona.id),
    ["workspace-admin", "project-owner", "platform-engineer", "support-operator"],
  );
  assert.deepEqual(
    ENVIRONMENT_LIFECYCLE_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(ENVIRONMENT_LIFECYCLE_SCOPE.scopeIn.length >= 5);
  assert.ok(ENVIRONMENT_LIFECYCLE_SCOPE.scopeOut.length >= 6);
  assert.ok(ENVIRONMENT_LIFECYCLE_SCOPE.nonGoals.some((item) => /provider/i.test(item)));
});

test("M0 dependencies map authoritative design sources and owning initiatives", () => {
  assert.deepEqual(ENVIRONMENT_LIFECYCLE_SCOPE.designRefs, [
    "docs/design/settings-project-lifecycle.md",
    "docs/design/organization-workspace-model.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/security-networking.md#plan-50",
    "docs/design/support-sla-channels.md",
    "docs/design/backup-restore.md",
    "docs/design/resource-garbage-collection.md",
  ]);
  assert.deepEqual(ENVIRONMENT_LIFECYCLE_SCOPE.adrRefs, [
    "docs/design/adr/02-identity-security.md#adr-0077",
    "docs/design/adr/02-identity-security.md#adr-0079",
    "docs/design/adr/02-identity-security.md#adr-0080",
    "docs/design/adr/07-portability-extensibility.md#adr-0042",
  ]);
  assert.deepEqual(
    ENVIRONMENT_LIFECYCLE_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Environment Lifecycle",
      "Settings & Project Lifecycle",
      "Admin Console",
      "Deployment Dashboard & Topology Explorer",
      "Tenant Isolation & Quotas",
      "Backup & Restore",
      "Resource Garbage Collection",
      "Support Workflow",
    ],
  );
});

test("environment classes, lifecycle states, and evidence fields are explicit", () => {
  assert.deepEqual(
    ENVIRONMENT_LIFECYCLE_SCOPE.environmentClasses.map((entry) => entry.id),
    ["local-dev", "preview", "development", "staging", "production", "ephemeral"],
  );
  assert.deepEqual(
    ENVIRONMENT_LIFECYCLE_SCOPE.lifecycleStates.map((state) => state.id),
    [
      "requested",
      "provisioning-blocked",
      "active",
      "suspended",
      "archived",
      "restore-pending",
      "deleting",
      "deleted-terminal",
    ],
  );
  assert.deepEqual(
    ENVIRONMENT_LIFECYCLE_SCOPE.requiredEvidence.map((field) => field.id),
    [
      "parent-project",
      "environment-owner",
      "tenant-boundary",
      "policy-class",
      "last-deployment-signal",
      "restore-point",
      "cleanup-handoff",
      "support-export",
    ],
  );
});

test("M1 evidence gate blocks follow-up implementation issues until M0 is accepted", () => {
  assert.deepEqual(
    ENVIRONMENT_LIFECYCLE_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "environment-schema",
      "lifecycle-state-machine",
      "transition-owner-matrix",
      "audit-event-fixture",
      "support-export-contract",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    canCreateEnvironmentLifecycleFollowUp({ phase: "M1", m0Accepted: false }).allowed,
    false,
  );
  assert.equal(
    canCreateEnvironmentLifecycleFollowUp({ phase: "M2", m0Accepted: false }).allowed,
    false,
  );
  assert.equal(
    canCreateEnvironmentLifecycleFollowUp({ phase: "M1", m0Accepted: true }).allowed,
    true,
  );
  assert.equal(
    canCreateEnvironmentLifecycleFollowUp({ phase: "M0", m0Accepted: false }).allowed,
    true,
  );
});

test("scope validation rejects runtime, provider, admin, RBAC, quota, and cleanup implementation creep", () => {
  assert.deepEqual(validateEnvironmentLifecycleScope(ENVIRONMENT_LIFECYCLE_SCOPE), {
    ok: true,
    errors: [],
  });

  for (const [label, sentence] of [
    ["runtime", "Implement the environment service runtime and persistence layer."],
    ["provider", "Provision live provider resources and DNS for production environments."],
    ["admin", "Build admin console screens for environment approval workflows."],
    ["rbac", "Implement RBAC enforcement and member role binding for environment actions."],
    ["quota", "Enforce tenant quotas and billing limits during environment creation."],
    ["cleanup", "Run live garbage collection and backup/restore runtime for archived environments."],
    ["cleanup", "Implement drift detection and teardown execution for deleted environments."],
  ]) {
    const result = validateEnvironmentLifecycleScope({
      ...ENVIRONMENT_LIFECYCLE_SCOPE,
      scopeIn: [...ENVIRONMENT_LIFECYCLE_SCOPE.scopeIn, sentence],
    });

    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), new RegExp(label, "i"));
  }
});

test("scope validation rejects records missing required environment evidence", () => {
  const result = validateEnvironmentLifecycleScope({
    ...ENVIRONMENT_LIFECYCLE_SCOPE,
    requiredEvidence: ENVIRONMENT_LIFECYCLE_SCOPE.requiredEvidence.filter(
      (evidence) => evidence.id !== "support-export",
    ),
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /support-export/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyEnvironmentLifecycleDecision("define environment lifecycle evidence"), {
    owner: "Environment Lifecycle",
    inScope: true,
  });
  assert.equal(
    classifyEnvironmentLifecycleDecision("project archive transition").owner,
    "Settings & Project Lifecycle",
  );
  assert.equal(
    classifyEnvironmentLifecycleDecision("admin console approval screen").owner,
    "Admin Console",
  );
  assert.equal(
    classifyEnvironmentLifecycleDecision("tenant quota enforcement").owner,
    "Tenant Isolation & Quotas",
  );
  assert.equal(
    classifyEnvironmentLifecycleDecision("backup restore drill").owner,
    "Backup & Restore",
  );
  assert.equal(
    classifyEnvironmentLifecycleDecision("live resource cleanup sweeper").owner,
    "Resource Garbage Collection",
  );
});
