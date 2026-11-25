import assert from "node:assert/strict";
import { test } from "vitest";

import {
  MARKETPLACE_UX_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateMarketplaceUxFollowUp,
  validateMarketplaceUxScope,
} from "../src/marketplace-ux-scope.js";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateMarketplaceUxScope(MARKETPLACE_UX_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(MARKETPLACE_UX_SCOPE.issue, "HOBO-421");
  assert.equal(MARKETPLACE_UX_SCOPE.phase, "M0");
  assert.match(MARKETPLACE_UX_SCOPE.goal, /marketplace ux/i);
  assert.match(MARKETPLACE_UX_SCOPE.goal, /browse/i);
  assert.match(MARKETPLACE_UX_SCOPE.goal, /install/i);
  assert.deepEqual(
    MARKETPLACE_UX_SCOPE.personas.map((persona) => persona.role),
    [
      "app developer",
      "workspace administrator",
      "marketplace operator",
      "security reviewer",
      "support operator",
    ],
  );
  assert.deepEqual(Object.keys(MARKETPLACE_UX_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(MARKETPLACE_UX_SCOPE.scopeIn.length >= 5);
  assert.ok(MARKETPLACE_UX_SCOPE.scopeOut.length >= 6);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    MARKETPLACE_UX_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/marketplace-publisher-trust-evidence.md",
      "docs/design/capability-review-approval.md",
      "docs/design/org-catalogs.md",
      "docs/design/accessibility-usability-launch-baseline.md",
      "docs/design/product-notifications-lifecycle.md",
      "docs/design/launch-messaging-claims.md",
      "docs/design/adr/07-portability-extensibility.md#adr-0062",
      "docs/design/adr/02-identity-security.md#adr-0074",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    MARKETPLACE_UX_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Marketplace UX",
      "Capability Review & Approval",
      "Marketplace Publisher Trust Evidence",
      "Org Catalogs",
      "Publisher Portal",
      "Registry Distribution",
      "Accessibility & Usability Quality",
      "Support Workflow",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    MARKETPLACE_UX_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists marketplace listing states and evidence required before M1 design", () => {
  assert.deepEqual(MARKETPLACE_UX_SCOPE.listingStates, [
    "not-visible",
    "preview-only",
    "limited-beta",
    "installable",
    "blocked-by-policy",
    "deprecated",
    "yanked",
  ]);
  assert.deepEqual(
    MARKETPLACE_UX_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "browse-taxonomy-fixture",
      "installability-outcome-matrix",
      "trust-warning-copy-register",
      "org-catalog-filter-fixture",
      "accessibility-usability-checklist",
      "support-handoff-export",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    MARKETPLACE_UX_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateMarketplaceUxFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateMarketplaceUxFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateMarketplaceUxFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateMarketplaceUxFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects storefront, install runtime, registry, monetization, rating, or publisher UI creep", () => {
  const result = validateMarketplaceUxScope({
    ...MARKETPLACE_UX_SCOPE,
    scopeIn: [
      ...MARKETPLACE_UX_SCOPE.scopeIn,
      "Build the live storefront, install runtime, Registry storage, ratings ranking, paid placement, payout, and publisher portal UI.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation fails closed when installability claims lack source or customer-safe owner route", () => {
  const result = validateMarketplaceUxScope({
    ...MARKETPLACE_UX_SCOPE,
    listingStates: MARKETPLACE_UX_SCOPE.listingStates.filter((state) => state !== "blocked-by-policy"),
    installabilityOutcomes: [
      ...MARKETPLACE_UX_SCOPE.installabilityOutcomes,
      {
        id: "safe-to-install",
        customerVisible: true,
        customerMessage: "This listing is safe to install.",
      },
    ],
    m1Evidence: [
      ...MARKETPLACE_UX_SCOPE.m1Evidence,
      {
        kind: "install-now-claim",
        owner: "marketplace operator",
        proofMode: "contract-test",
        proves: "Any listed package can be installed.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /listing state missing: blocked-by-policy/i);
  assert.match(result.errors.join("\n"), /customer-visible installability outcome/i);
  assert.match(result.errors.join("\n"), /source/i);
});
