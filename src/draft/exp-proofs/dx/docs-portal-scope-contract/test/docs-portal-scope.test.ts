import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DOCS_PORTAL_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateDocsPortalFollowUp,
  validateDocsPortalScope,
} from "../src/docs-portal-scope.js";

test("M0 record states Docs Portal goal, personas, scope, non-goals, and boundaries", () => {
  const result = validateDocsPortalScope(DOCS_PORTAL_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(DOCS_PORTAL_SCOPE.issue, "HOBO-434");
  assert.equal(DOCS_PORTAL_SCOPE.phase, "M0");
  assert.match(DOCS_PORTAL_SCOPE.goal, /docs portal/i);
  assert.deepEqual(
    DOCS_PORTAL_SCOPE.personas.map((persona) => persona.role),
    [
      "app developer",
      "platform engineer",
      "support operator",
      "security reviewer",
      "docs maintainer",
      "release owner",
    ],
  );
  assert.deepEqual(Object.keys(DOCS_PORTAL_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(DOCS_PORTAL_SCOPE.scopeIn.length >= 6);
  assert.ok(DOCS_PORTAL_SCOPE.scopeOut.length >= 7);
});

test("M0 record maps dependencies to authoritative docs, release, support, and security sources", () => {
  assert.deepEqual(
    DOCS_PORTAL_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/release-notes-upgrade-guide.md",
      "docs/design/compatibility-matrix.md",
      "docs/design/launch-messaging-claims.md",
      "docs/design/support-sla-channels.md",
      "docs/design/launch-support-escalation.md",
      "docs/design/security-verification.md",
      "docs/design/accessibility-usability-launch-baseline.md",
      "docs/design/adr/02-identity-security.md#adr-0082",
    ],
  );
});

test("M0 record maps owning initiatives without taking adjacent implementation scope", () => {
  assert.deepEqual(
    DOCS_PORTAL_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Docs Portal",
      "Tutorials & Walkthroughs",
      "Troubleshooting Guides",
      "V1 Release Notes & Upgrade Guide",
      "Compatibility Matrix",
      "Support Workflow",
      "Security Verification",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    DOCS_PORTAL_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists portal content areas and M1 proof evidence before implementation", () => {
  assert.deepEqual(DOCS_PORTAL_SCOPE.portalContentAreas, [
    "getting-started",
    "api-reference",
    "architecture-and-concepts",
    "operations-and-troubleshooting",
    "release-notes-and-upgrades",
    "known-limitations",
    "security-and-support",
  ]);
  assert.deepEqual(
    DOCS_PORTAL_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "content-inventory-fixture",
      "audience-path-map",
      "navigation-taxonomy",
      "versioning-and-limitation-register",
      "search-index-contract",
      "support-handoff-routes",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    DOCS_PORTAL_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateDocsPortalFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateDocsPortalFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateDocsPortalFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateDocsPortalFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects portal UI, CMS, search service, analytics, support, or marketing implementation creep", () => {
  const result = validateDocsPortalScope({
    ...DOCS_PORTAL_SCOPE,
    scopeIn: [
      ...DOCS_PORTAL_SCOPE.scopeIn,
      "Build React docs portal UI, CMS authoring workflow, search indexing service, analytics pipeline, support ticket automation, and marketing site publishing.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation fails closed when customer-facing claims lack owner route or proof source", () => {
  const result = validateDocsPortalScope({
    ...DOCS_PORTAL_SCOPE,
    portalContentAreas: DOCS_PORTAL_SCOPE.portalContentAreas.filter(
      (area) => area !== "known-limitations",
    ),
    m1Evidence: [
      ...DOCS_PORTAL_SCOPE.m1Evidence,
      {
        kind: "docs-portal-launch-ready",
        owner: "docs maintainer",
        proofMode: "contract-test",
        proves: "Docs portal is ready for public launch.",
      },
    ],
    customerFacingClaims: [
      ...DOCS_PORTAL_SCOPE.customerFacingClaims,
      {
        id: "complete-production-docs",
        customerVisible: true,
      },
    ],
  });

  assert.match(result.errors.join("\n"), /portal content area missing: known-limitations/i);
  assert.match(result.errors.join("\n"), /source/i);
  assert.match(result.errors.join("\n"), /customer-facing claim/i);
});
