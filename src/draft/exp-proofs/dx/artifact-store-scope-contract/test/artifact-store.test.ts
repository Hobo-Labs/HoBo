import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ARTIFACT_STORE_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateArtifactStoreFollowUp,
  classifyArtifactStoreDecision,
  validateArtifactStoreScope,
} from "../src/artifact-store.ts";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(ARTIFACT_STORE_SCOPE.issue, "HOBO-445");
  assert.equal(ARTIFACT_STORE_SCOPE.project, "Artifact Store");
  assert.equal(ARTIFACT_STORE_SCOPE.phase, "M0");
  assert.match(ARTIFACT_STORE_SCOPE.goal, /artifact store/i);
  assert.match(ARTIFACT_STORE_SCOPE.goal, /scope and acceptance/i);
  assert.deepEqual(
    ARTIFACT_STORE_SCOPE.personas.map((persona) => persona.id),
    ["release-engineer", "platform-engineer", "security-reviewer", "support-operator", "customer-admin"],
  );
  assert.deepEqual(
    ARTIFACT_STORE_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(ARTIFACT_STORE_SCOPE.scopeIn.length >= 5);
  assert.ok(ARTIFACT_STORE_SCOPE.scopeOut.length >= 6);
  assert.ok(ARTIFACT_STORE_SCOPE.nonGoals.some((item) => /blob store/i.test(item)));
});

test("artifact classes, custody states, and required evidence are explicit", () => {
  assert.deepEqual(
    ARTIFACT_STORE_SCOPE.artifactClasses.map((entry) => entry.id),
    ["wasm-component", "oci-image", "resource-pack", "offline-bundle", "release-asset", "generated-provider"],
  );
  assert.deepEqual(
    ARTIFACT_STORE_SCOPE.custodyStates.map((state) => state.id),
    ["declared", "accepted", "retained", "yanked", "expired", "quarantined"],
  );
  assert.deepEqual(
    ARTIFACT_STORE_SCOPE.requiredEvidence.map((field) => field.id),
    [
      "artifact-identity",
      "digest-and-size",
      "provenance-link",
      "retention-class",
      "access-policy",
      "yank-invalidation",
      "support-debug-handoff",
      "customer-assurance-boundary",
    ],
  );
});

test("dependencies map authoritative design sources and owning initiatives", () => {
  assert.deepEqual(ARTIFACT_STORE_SCOPE.designRefs, [
    "docs/design/provenance-retention.md",
    "docs/design/release-artifact-provenance-retention.md",
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/technical-standards.md",
  ]);
  assert.deepEqual(ARTIFACT_STORE_SCOPE.adrRefs, [
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/07-portability-extensibility.md#adr-0073",
    "docs/design/adr/01-architecture-core.md#adr-0085",
  ]);
  assert.deepEqual(
    ARTIFACT_STORE_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Artifact Store",
      "Provenance & Retention",
      "Release Engineering",
      "Registry & Distribution",
      "Package Cache",
      "Capability Review & Approval",
      "Support Workflow",
    ],
  );
});

test("M1 evidence gate blocks follow-up issues until M0 is accepted", () => {
  assert.deepEqual(
    ARTIFACT_STORE_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "artifact-record-schema",
      "custody-state-machine",
      "retention-policy-matrix",
      "access-policy-contract",
      "yank-invalidation-fixture",
      "support-debug-handoff",
      "customer-assurance-summary",
    ],
  );
  assert.equal(canCreateArtifactStoreFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateArtifactStoreFollowUp({ phase: "M2", m0Accepted: false }).allowed, false);
  assert.equal(canCreateArtifactStoreFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateArtifactStoreFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects blob, registry, signing, pipeline, UI, support, and customer-data creep", () => {
  assert.deepEqual(validateArtifactStoreScope(ARTIFACT_STORE_SCOPE), {
    ok: true,
    errors: [],
  });

  for (const [label, sentence] of [
    ["storage", "Build the production blob store and lifecycle worker."],
    ["registry", "Implement the registry backend and distributed resolver."],
    ["signing", "Create signing keys, KMS integration, and certificate rotation."],
    ["pipeline", "Build live release pipelines and package publishing jobs."],
    ["ui", "Ship artifact browser UI and retention dashboards."],
    ["support", "Implement support ticket automation and live debug collection."],
    ["customer-data", "Store customer data snapshots and tenant backups as artifacts."],
  ]) {
    const result = validateArtifactStoreScope({
      ...ARTIFACT_STORE_SCOPE,
      scopeIn: [...ARTIFACT_STORE_SCOPE.scopeIn, sentence],
    });

    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), new RegExp(label, "i"));
  }
});

test("scope validation rejects records missing required evidence fields", () => {
  const result = validateArtifactStoreScope({
    ...ARTIFACT_STORE_SCOPE,
    requiredEvidence: ARTIFACT_STORE_SCOPE.requiredEvidence.filter(
      (evidence) => evidence.id !== "access-policy",
    ),
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /access-policy/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyArtifactStoreDecision("define artifact store acceptance evidence"), {
    owner: "Artifact Store",
    inScope: true,
  });
  assert.equal(classifyArtifactStoreDecision("build production blob lifecycle").owner, "Artifact Store");
  assert.equal(classifyArtifactStoreDecision("signed provenance retention matrix").owner, "Provenance & Retention");
  assert.equal(classifyArtifactStoreDecision("release pipeline publish gate").owner, "Release Engineering");
  assert.equal(classifyArtifactStoreDecision("registry listing mirror").owner, "Registry & Distribution");
  assert.equal(classifyArtifactStoreDecision("package cache invalidation").owner, "Package Cache");
  assert.equal(classifyArtifactStoreDecision("capability trust review evidence").owner, "Capability Review & Approval");
  assert.equal(classifyArtifactStoreDecision("support ticket automation").owner, "Support Workflow");
});
