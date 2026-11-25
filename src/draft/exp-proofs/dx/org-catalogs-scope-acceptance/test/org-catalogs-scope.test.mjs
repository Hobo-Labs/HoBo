import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ORG_CATALOGS_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateOrgCatalogFollowUp,
  classifyOrgCatalogDecision,
  validateOrgCatalogsScope,
} from "../src/org-catalogs-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(ORG_CATALOGS_SCOPE.issue, "HOBO-424");
  assert.equal(ORG_CATALOGS_SCOPE.project, "Org Catalogs");
  assert.equal(ORG_CATALOGS_SCOPE.phase, "M0");
  assert.match(ORG_CATALOGS_SCOPE.goal, /org catalog/i);
  assert.match(ORG_CATALOGS_SCOPE.goal, /approved catalog/i);
  assert.deepEqual(
    ORG_CATALOGS_SCOPE.personas.map((persona) => persona.id),
    ["workspace-admin", "platform-engineer", "app-developer", "support-operator"],
  );
  assert.deepEqual(
    ORG_CATALOGS_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(ORG_CATALOGS_SCOPE.scopeIn.some((item) => /catalog kind/i.test(item)));
  assert.ok(ORG_CATALOGS_SCOPE.scopeOut.some((item) => /registry storage/i.test(item)));
  assert.ok(ORG_CATALOGS_SCOPE.nonGoals.some((item) => /marketplace/i.test(item)));
});

test("M0 dependencies map authoritative design sources and owning initiatives", () => {
  assert.ok(
    ORG_CATALOGS_SCOPE.designRefs.includes("docs/design/organization-workspace-model.md"),
  );
  assert.ok(ORG_CATALOGS_SCOPE.designRefs.includes("docs/design/walkthrough.md"));
  assert.ok(
    ORG_CATALOGS_SCOPE.adrRefs.includes(
      "docs/design/adr/07-portability-extensibility.md#adr-0062",
    ),
  );
  assert.ok(
    ORG_CATALOGS_SCOPE.adrRefs.includes(
      "docs/design/adr/02-identity-security.md#adr-0074",
    ),
  );
  assert.ok(
    ORG_CATALOGS_SCOPE.initiativeDependencies.some(
      (dependency) =>
        dependency.owner === "Marketplace Publisher Trust Evidence" &&
        /trust tiers/i.test(dependency.boundary),
    ),
  );
});

test("catalog kinds, entry states, and evidence fields are explicit", () => {
  assert.deepEqual(
    ORG_CATALOGS_SCOPE.catalogKinds.map((kind) => kind.id),
    [
      "provider-pack",
      "resource-pack",
      "template-bindle",
      "policy-pack",
      "private-listing",
    ],
  );
  assert.deepEqual(
    ORG_CATALOGS_SCOPE.entryStates.map((state) => state.id),
    ["proposed", "approved", "deprecated", "blocked", "retired"],
  );
  assert.deepEqual(
    ORG_CATALOGS_SCOPE.requiredEntryEvidence.map((field) => field.id),
    [
      "source",
      "owner",
      "trust-tier",
      "scope",
      "version-pin",
      "policy",
      "support-handoff",
    ],
  );
});

test("M1 evidence gate blocks follow-up implementation issues until M0 is accepted", () => {
  assert.deepEqual(
    ORG_CATALOGS_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "catalog-schema",
      "approval-state-machine",
      "policy-consumption-fixture",
      "registry-handoff",
      "support-export",
      "scope-boundary-register",
    ],
  );
  assert.equal(canCreateOrgCatalogFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateOrgCatalogFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateOrgCatalogFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects runtime, marketplace, registry, billing, and unowned-approval creep", () => {
  assert.deepEqual(validateOrgCatalogsScope(ORG_CATALOGS_SCOPE), { ok: true, errors: [] });

  const runtimeCreep = validateOrgCatalogsScope({
    ...ORG_CATALOGS_SCOPE,
    scopeIn: [...ORG_CATALOGS_SCOPE.scopeIn, "Implement the install-time resolver runtime."],
  });
  assert.equal(runtimeCreep.ok, false);
  assert.match(runtimeCreep.errors.join("\n"), /runtime/i);

  const registryCreep = validateOrgCatalogsScope({
    ...ORG_CATALOGS_SCOPE,
    scopeIn: [...ORG_CATALOGS_SCOPE.scopeIn, "Build live registry storage for catalog entries."],
  });
  assert.equal(registryCreep.ok, false);
  assert.match(registryCreep.errors.join("\n"), /registry/i);

  const monetizationCreep = validateOrgCatalogsScope({
    ...ORG_CATALOGS_SCOPE,
    scopeIn: [...ORG_CATALOGS_SCOPE.scopeIn, "Add paid marketplace placement and payouts."],
  });
  assert.equal(monetizationCreep.ok, false);
  assert.match(monetizationCreep.errors.join("\n"), /marketplace/i);

  const missingPolicy = validateOrgCatalogsScope({
    ...ORG_CATALOGS_SCOPE,
    requiredEntryEvidence: ORG_CATALOGS_SCOPE.requiredEntryEvidence.filter(
      (field) => field.id !== "policy",
    ),
  });
  assert.equal(missingPolicy.ok, false);
  assert.match(missingPolicy.errors.join("\n"), /policy/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyOrgCatalogDecision("approve provider pack with policy pin"), {
    owner: "Org Catalogs",
    inScope: true,
  });
  assert.equal(
    classifyOrgCatalogDecision("publish listing to live registry storage").owner,
    "Registry & Distribution",
  );
  assert.equal(
    classifyOrgCatalogDecision("marketplace publisher rating and payout workflow").owner,
    "Marketplace UX / Publisher Portal",
  );
  assert.equal(
    classifyOrgCatalogDecision("RBAC role grant for catalog approvers").owner,
    "Member/RBAC Administration",
  );
  assert.equal(
    classifyOrgCatalogDecision("install resolver runtime for selected catalog item").owner,
    "Portability, Registry & Distribution",
  );
});
