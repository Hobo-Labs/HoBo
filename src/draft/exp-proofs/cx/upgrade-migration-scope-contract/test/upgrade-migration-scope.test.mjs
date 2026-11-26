import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_BOUNDARIES,
  UPGRADE_MIGRATION_SCOPE,
  canCreateUpgradeMigrationFollowUp,
  classifyUpgradeMigrationDecision,
  validateUpgradeMigrationScope,
} from "../src/upgrade-migration-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  assert.deepEqual(validateUpgradeMigrationScope(UPGRADE_MIGRATION_SCOPE), {
    ok: true,
    errors: [],
  });
  assert.equal(UPGRADE_MIGRATION_SCOPE.issue, "HOBO-430");
  assert.equal(UPGRADE_MIGRATION_SCOPE.project, "Upgrade & Migration Engine");
  assert.equal(UPGRADE_MIGRATION_SCOPE.phase, "M0");
  assert.match(UPGRADE_MIGRATION_SCOPE.goal, /upgrade/i);
  assert.match(UPGRADE_MIGRATION_SCOPE.goal, /migration/i);
  assert.deepEqual(
    UPGRADE_MIGRATION_SCOPE.personas.map((persona) => persona.id),
    [
      "release-owner",
      "platform-engineer",
      "devops-operator",
      "support-operator",
      "security-compliance-reviewer",
    ],
  );
  assert.deepEqual(
    UPGRADE_MIGRATION_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(UPGRADE_MIGRATION_SCOPE.scopeIn.some((item) => /dry-run/i.test(item)));
  assert.ok(UPGRADE_MIGRATION_SCOPE.scopeOut.some((item) => /production upgrade runner/i.test(item)));
});

test("M0 dependencies map authoritative design sources and owning initiatives", () => {
  assert.deepEqual(UPGRADE_MIGRATION_SCOPE.designRefs, [
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/data-plane.md#plan-32",
    "docs/design/wasm-runtime-wit.md#plan-20",
    "docs/design/walkthrough.md",
  ]);
  assert.deepEqual(UPGRADE_MIGRATION_SCOPE.adrRefs, [
    "docs/design/adr/03-data-plane.md#adr-0032",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
    "docs/design/adr/07-portability-extensibility.md#adr-0057",
    "docs/design/adr/07-portability-extensibility.md#adr-0095",
  ]);
  assert.ok(
    UPGRADE_MIGRATION_SCOPE.initiativeDependencies.some(
      (dependency) =>
        dependency.owner === "Backup & Restore" &&
        /backup requirement/i.test(dependency.boundary),
    ),
  );
});

test("M1 evidence covers compatibility, migration, rollback, support, and scope gates", () => {
  assert.deepEqual(
    UPGRADE_MIGRATION_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "upgrade-scope-record",
      "compatibility-input-matrix",
      "migration-dry-run-contract",
      "rollback-evidence-fixture",
      "release-notes-support-handoff",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    UPGRADE_MIGRATION_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.mode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("M1-M4 follow-up issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateUpgradeMigrationFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateUpgradeMigrationFollowUp({ phase: "M2", m0Accepted: false }).allowed, false);
  assert.equal(canCreateUpgradeMigrationFollowUp({ phase: "M4", m0Accepted: false }).allowed, false);
  assert.equal(canCreateUpgradeMigrationFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateUpgradeMigrationFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects live migration, rollback, backup, provider, and data rewrite creep", () => {
  const result = validateUpgradeMigrationScope({
    ...UPGRADE_MIGRATION_SCOPE,
    scopeIn: [
      ...UPGRADE_MIGRATION_SCOPE.scopeIn,
      "Implement the production upgrade runner, live schema migration, rollback executor, backup restore, and provider state rewrite.",
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyUpgradeMigrationDecision("define the migration dry-run contract"), {
    owner: "Upgrade & Migration Engine",
    inScope: true,
  });
  assert.equal(
    classifyUpgradeMigrationDecision("implement backup restore execution").owner,
    "Backup & Restore",
  );
  assert.equal(
    classifyUpgradeMigrationDecision("publish release notes and customer upgrade guide").owner,
    "V1 Release Notes & Upgrade Guide",
  );
  assert.equal(
    classifyUpgradeMigrationDecision("build compatibility matrix UI").owner,
    "Compatibility Matrix",
  );
  assert.equal(
    classifyUpgradeMigrationDecision("rewrite provider state during live upgrade").owner,
    "Provider/IaC State Owners",
  );
});
