import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PROVENANCE_RETENTION_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateFollowUpIssue,
  validateProvenanceRetentionScope,
} from "../src/provenance-retention.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateProvenanceRetentionScope(PROVENANCE_RETENTION_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(PROVENANCE_RETENTION_SCOPE.issue, "HOBO-447");
  assert.equal(PROVENANCE_RETENTION_SCOPE.phase, "M0");
  assert.match(PROVENANCE_RETENTION_SCOPE.goal, /provenance/i);
  assert.match(PROVENANCE_RETENTION_SCOPE.goal, /retention/i);
  assert.deepEqual(
    PROVENANCE_RETENTION_SCOPE.personas.map((persona) => persona.role),
    [
      "release engineer",
      "security reviewer",
      "compliance lead",
      "support operator",
      "customer admin",
    ],
  );
  assert.deepEqual(Object.keys(PROVENANCE_RETENTION_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(PROVENANCE_RETENTION_SCOPE.scopeIn.length >= 6);
  assert.ok(PROVENANCE_RETENTION_SCOPE.scopeOut.length >= 6);
  assert.ok(PROVENANCE_RETENTION_SCOPE.nonGoals.length >= 4);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    PROVENANCE_RETENTION_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/governance-planes.md#plan-46",
      "docs/design/platform-engineering.md#plan-25",
      "docs/design/contracts-policy-flags.md#plan-29",
      "docs/design/adr/07-portability-extensibility.md#adr-0062",
      "docs/design/adr/07-portability-extensibility.md#adr-0073",
      "docs/design/adr/02-identity-security.md#adr-0046",
      "docs/design/adr/02-identity-security.md#adr-0023",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    PROVENANCE_RETENTION_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Provenance & Retention",
      "Release Channels",
      "Compatibility Matrix",
      "Upgrade Test Suite",
      "Backup & Restore",
      "Capability Review & Approval",
      "Audit Explorer",
      "Support & Debug Tools",
    ],
  );
  assert.equal(
    PROVENANCE_RETENTION_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    PROVENANCE_RETENTION_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "artifact-provenance-schema",
      "retention-policy-matrix",
      "audit-export-fixture",
      "support-debug-handoff",
      "yank-invalidation-playbook",
      "customer-assurance-summary",
    ],
  );
  assert.equal(
    PROVENANCE_RETENTION_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateFollowUpIssue({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects artifact-store, signing-key, or live-registry implementation creep", () => {
  const result = validateProvenanceRetentionScope({
    ...PROVENANCE_RETENTION_SCOPE,
    scopeIn: [
      ...PROVENANCE_RETENTION_SCOPE.scopeIn,
      "Build the artifact store, manage signing keys, and run live registry crawls.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires evidence sources for customer-visible assurance claims", () => {
  const result = validateProvenanceRetentionScope({
    ...PROVENANCE_RETENTION_SCOPE,
    assuranceClaims: [
      ...PROVENANCE_RETENTION_SCOPE.assuranceClaims,
      {
        claim: "Every retained artifact is customer-ready.",
        audience: "customer admin",
        customerVisible: true,
      },
    ],
  });

  assert.match(result.errors.join("\n"), /evidence source/i);
});
