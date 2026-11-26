import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PACKAGE_CACHE_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreatePackageCacheFollowUp,
  classifyPackageCacheDecision,
  validatePackageCacheScope,
} from "../src/package-cache.ts";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(PACKAGE_CACHE_SCOPE.issue, "HOBO-446");
  assert.equal(PACKAGE_CACHE_SCOPE.project, "Package Cache");
  assert.equal(PACKAGE_CACHE_SCOPE.phase, "M0");
  assert.match(PACKAGE_CACHE_SCOPE.goal, /package cache/i);
  assert.match(PACKAGE_CACHE_SCOPE.goal, /scope and acceptance/i);
  assert.deepEqual(
    PACKAGE_CACHE_SCOPE.personas.map((persona) => persona.id),
    ["release-engineer", "platform-engineer", "security-reviewer", "support-operator", "offline-admin"],
  );
  assert.deepEqual(
    PACKAGE_CACHE_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(PACKAGE_CACHE_SCOPE.scopeIn.length >= 5);
  assert.ok(PACKAGE_CACHE_SCOPE.scopeOut.length >= 6);
  assert.ok(PACKAGE_CACHE_SCOPE.nonGoals.some((item) => /registry backend/i.test(item)));
});

test("dependencies map authoritative design sources and owning initiatives", () => {
  assert.deepEqual(PACKAGE_CACHE_SCOPE.designRefs, [
    "docs/design/package-namespaces.md",
    "docs/design/release-artifact-provenance-retention.md",
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "docs/design/bootstrap-installer.md",
    "docs/design/compatibility-matrix.md",
    "docs/design/security-verification.md",
    "docs/design/support-sla-channels.md",
    "docs/design/tenant-data-lifecycle.md",
  ]);
  assert.deepEqual(PACKAGE_CACHE_SCOPE.adrRefs, [
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/07-portability-extensibility.md#adr-0095",
    "docs/design/adr/02-identity-security.md#adr-0023",
    "docs/design/adr/02-identity-security.md#adr-0082",
  ]);
  assert.deepEqual(
    PACKAGE_CACHE_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Package Cache",
      "Artifact Store",
      "Portability Registry",
      "Release Artifact Provenance",
      "SBOM Vulnerability Notice Evidence",
      "Bootstrap Installer",
      "Security Verification",
      "Support Workflow",
    ],
  );
});

test("cache subjects, evidence fields, and result states are explicit", () => {
  assert.deepEqual(
    PACKAGE_CACHE_SCOPE.cacheSubjects.map((entry) => entry.id),
    ["npm-package", "wit-interface", "wasm-component", "oci-artifact", "offline-bundle"],
  );
  assert.deepEqual(
    PACKAGE_CACHE_SCOPE.requiredEvidence.map((field) => field.id),
    [
      "package-coordinate",
      "digest",
      "source-registry",
      "provenance-ref",
      "sbom-ref",
      "vulnerability-state",
      "invalidation-policy",
      "retention-class",
      "offline-availability",
      "support-handoff",
    ],
  );
  assert.deepEqual(
    PACKAGE_CACHE_SCOPE.resultStates.map((state) => state.id),
    ["cacheable", "blocked", "unsupported", "quarantined", "invalidated", "needs-manual-review"],
  );
});

test("M1 evidence gate blocks follow-up issues until M0 is accepted", () => {
  assert.deepEqual(
    PACKAGE_CACHE_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "cache-subject-matrix",
      "digest-lock-fixtures",
      "invalidation-contract",
      "offline-cache-manifest",
      "security-quarantine-rules",
      "support-debug-record",
      "retention-policy-map",
    ],
  );
  assert.equal(canCreatePackageCacheFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreatePackageCacheFollowUp({ phase: "M2", m0Accepted: false }).allowed, false);
  assert.equal(canCreatePackageCacheFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreatePackageCacheFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects registry, mirror, installer, security, support, and live-network creep", () => {
  assert.deepEqual(validatePackageCacheScope(PACKAGE_CACHE_SCOPE), {
    ok: true,
    errors: [],
  });

  for (const [label, sentence] of [
    ["registry", "Build the production registry backend and package publishing API."],
    ["mirror", "Implement a live package mirror and CDN edge cache service."],
    ["installer", "Modify hobo install, bootstrap flows, and package manager clients."],
    ["security", "Scan arbitrary customer packages and make vulnerability approval decisions."],
    ["support", "Automate support tickets and customer notifications for cache misses."],
    ["network", "Fetch packages from the public internet during acceptance tests."],
  ]) {
    const result = validatePackageCacheScope({
      ...PACKAGE_CACHE_SCOPE,
      scopeIn: [...PACKAGE_CACHE_SCOPE.scopeIn, sentence],
    });

    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), new RegExp(label, "i"));
  }
});

test("scope validation rejects records missing required evidence fields", () => {
  const result = validatePackageCacheScope({
    ...PACKAGE_CACHE_SCOPE,
    requiredEvidence: PACKAGE_CACHE_SCOPE.requiredEvidence.filter((evidence) => evidence.id !== "digest"),
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /digest/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyPackageCacheDecision("define package cache acceptance evidence"), {
    owner: "Package Cache",
    inScope: true,
  });
  assert.equal(classifyPackageCacheDecision("artifact store blob retention").owner, "Artifact Store");
  assert.equal(classifyPackageCacheDecision("registry publishing backend").owner, "Portability Registry");
  assert.equal(classifyPackageCacheDecision("release provenance invalidation").owner, "Release Artifact Provenance");
  assert.equal(classifyPackageCacheDecision("SBOM vulnerability notice").owner, "SBOM Vulnerability Notice Evidence");
  assert.equal(classifyPackageCacheDecision("bootstrap install package fetch").owner, "Bootstrap Installer");
  assert.equal(classifyPackageCacheDecision("security quarantine decision").owner, "Security Verification");
  assert.equal(classifyPackageCacheDecision("support ticket cache miss").owner, "Support Workflow");
});
