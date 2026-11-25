import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PUBLISHER_PORTAL_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreatePublisherPortalFollowUp,
  validatePublisherPortalScope,
} from "../src/publisher-portal-scope.js";

test("M0 record states publisher portal goal, personas, scope, non-goals, and boundaries", () => {
  const result = validatePublisherPortalScope(PUBLISHER_PORTAL_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(PUBLISHER_PORTAL_SCOPE.issue, "HOBO-422");
  assert.equal(PUBLISHER_PORTAL_SCOPE.phase, "M0");
  assert.match(PUBLISHER_PORTAL_SCOPE.goal, /publisher portal/i);
  assert.deepEqual(
    PUBLISHER_PORTAL_SCOPE.personas.map((persona) => persona.role),
    [
      "publisher owner",
      "publisher maintainer",
      "marketplace operator",
      "security reviewer",
      "support operator",
      "release owner",
    ],
  );
  assert.deepEqual(Object.keys(PUBLISHER_PORTAL_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(PUBLISHER_PORTAL_SCOPE.scopeIn.length >= 6);
  assert.ok(PUBLISHER_PORTAL_SCOPE.scopeOut.length >= 7);
});

test("M0 record maps dependencies to authoritative marketplace and governance sources", () => {
  assert.deepEqual(
    PUBLISHER_PORTAL_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/marketplace-publisher-trust-evidence.md",
      "docs/design/capability-review-approval.md",
      "docs/design/marketplace-payout-hooks.md",
      "docs/design/org-catalogs.md",
      "docs/design/billing-launch-policy.md",
      "docs/design/launch-support-escalation.md",
      "docs/design/adr/07-portability-extensibility.md#adr-0062",
      "docs/design/adr/02-identity-security.md#adr-0074",
      "docs/design/adr/07-portability-extensibility.md#adr-0064",
    ],
  );
});

test("M0 record maps owning initiatives without taking adjacent implementation scope", () => {
  assert.deepEqual(
    PUBLISHER_PORTAL_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Publisher Portal",
      "Capability Review & Approval",
      "Marketplace Publisher Trust Evidence",
      "Marketplace Payout Hooks",
      "Org Catalogs",
      "Billing & Credits",
      "Support Workflow",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    PUBLISHER_PORTAL_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists portal states and M1 proof evidence before implementation", () => {
  assert.deepEqual(PUBLISHER_PORTAL_SCOPE.portalStates, [
    "draft-profile",
    "identity-pending",
    "evidence-required",
    "ready-for-review",
    "limited-beta-visible",
    "installable-visible",
    "rejected",
    "yanked",
    "payout-readiness-blocked",
    "support-escalated",
  ]);
  assert.deepEqual(
    PUBLISHER_PORTAL_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "publisher-profile-fixture",
      "maintainer-permission-matrix",
      "submission-evidence-envelope",
      "review-status-projection",
      "payout-readiness-handoff",
      "support-escalation-handoff",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    PUBLISHER_PORTAL_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreatePublisherPortalFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreatePublisherPortalFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreatePublisherPortalFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreatePublisherPortalFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects portal UI, review decisioning, registry, payout, billing, or support implementation creep", () => {
  const result = validatePublisherPortalScope({
    ...PUBLISHER_PORTAL_SCOPE,
    scopeIn: [
      ...PUBLISHER_PORTAL_SCOPE.scopeIn,
      "Build React publisher portal UI, review approval service, live Registry storage, payout provider integration, billing dashboards, and support ticket automation.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation fails closed when customer-visible claims lack owner route or proof source", () => {
  const result = validatePublisherPortalScope({
    ...PUBLISHER_PORTAL_SCOPE,
    portalStates: PUBLISHER_PORTAL_SCOPE.portalStates.filter((state) => state !== "yanked"),
    m1Evidence: [
      ...PUBLISHER_PORTAL_SCOPE.m1Evidence,
      {
        kind: "publisher-can-launch",
        owner: "publisher owner",
        proofMode: "contract-test",
        proves: "Publisher listings are ready for customer use.",
      },
    ],
    customerVisibleStatuses: [
      ...PUBLISHER_PORTAL_SCOPE.customerVisibleStatuses,
      {
        id: "fully-trusted",
        customerVisible: true,
      },
    ],
  });

  assert.match(result.errors.join("\n"), /portal state missing: yanked/i);
  assert.match(result.errors.join("\n"), /source/i);
  assert.match(result.errors.join("\n"), /customer-visible status/i);
});
