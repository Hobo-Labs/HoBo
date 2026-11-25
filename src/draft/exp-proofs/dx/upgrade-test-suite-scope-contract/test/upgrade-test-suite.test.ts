import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_BOUNDARIES,
  UPGRADE_TEST_SUITE_SCOPE,
  canCreateUpgradeTestSuiteFollowUp,
  classifyUpgradeTestSuiteDecision,
  validateUpgradeTestSuiteScope,
} from "../src/upgrade-test-suite.ts";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(UPGRADE_TEST_SUITE_SCOPE.issue, "HOBO-433");
  assert.equal(UPGRADE_TEST_SUITE_SCOPE.project, "Upgrade Test Suite");
  assert.equal(UPGRADE_TEST_SUITE_SCOPE.phase, "M0");
  assert.match(UPGRADE_TEST_SUITE_SCOPE.goal, /upgrade test suite/i);
  assert.match(UPGRADE_TEST_SUITE_SCOPE.goal, /scope and acceptance/i);
  assert.deepEqual(
    UPGRADE_TEST_SUITE_SCOPE.personas.map((persona) => persona.id),
    ["release-owner", "platform-engineer", "devops-operator", "support-operator", "security-reviewer"],
  );
  assert.deepEqual(
    UPGRADE_TEST_SUITE_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(UPGRADE_TEST_SUITE_SCOPE.scopeIn.length >= 5);
  assert.ok(UPGRADE_TEST_SUITE_SCOPE.scopeOut.length >= 6);
  assert.ok(UPGRADE_TEST_SUITE_SCOPE.nonGoals.some((item) => /live migration/i.test(item)));
});

test("dependencies map authoritative design sources and owning initiatives", () => {
  assert.deepEqual(UPGRADE_TEST_SUITE_SCOPE.designRefs, [
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/compatibility-matrix.md",
    "docs/design/backup-restore.md",
    "docs/design/bootstrap-installer.md",
    "docs/design/tenant-data-lifecycle.md",
    "docs/design/security-verification.md",
    "docs/design/support-sla-channels.md",
    "docs/design/upgrade-migration-engine.md",
  ]);
  assert.deepEqual(UPGRADE_TEST_SUITE_SCOPE.adrRefs, [
    "docs/design/adr/03-data-plane.md#adr-0032",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
    "docs/design/adr/07-portability-extensibility.md#adr-0042",
    "docs/design/adr/07-portability-extensibility.md#adr-0057",
    "docs/design/adr/02-identity-security.md#adr-0082",
  ]);
  assert.deepEqual(
    UPGRADE_TEST_SUITE_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Upgrade Test Suite",
      "Upgrade & Migration Engine",
      "Compatibility Matrix",
      "Backup & Restore",
      "Bootstrap Installer",
      "V1 Release Notes & Upgrade Guide",
      "Security Verification",
      "Support Workflow",
    ],
  );
});

test("scenario matrix, required evidence, and result states are explicit", () => {
  assert.deepEqual(
    UPGRADE_TEST_SUITE_SCOPE.scenarioClasses.map((entry) => entry.id),
    ["hosted-control-plane", "self-host-yard", "local-dev-runtime", "sdk-package", "data-shape"],
  );
  assert.deepEqual(
    UPGRADE_TEST_SUITE_SCOPE.requiredEvidence.map((field) => field.id),
    [
      "source-version",
      "target-version",
      "deployment-mode",
      "compatibility-matrix-ref",
      "preflight-result",
      "backup-restore-proof",
      "migration-plan",
      "rollback-proof",
      "security-review-state",
      "support-handoff",
    ],
  );
  assert.deepEqual(
    UPGRADE_TEST_SUITE_SCOPE.resultStates.map((state) => state.id),
    ["passed", "blocked", "unsupported", "needs-manual-review", "waived-with-risk", "failed"],
  );
});

test("M1 evidence gate blocks follow-up issues until M0 is accepted", () => {
  assert.deepEqual(
    UPGRADE_TEST_SUITE_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "upgrade-scenario-matrix",
      "fixture-corpus",
      "preflight-contract",
      "migration-dry-run-report",
      "rollback-drill-fixture",
      "compatibility-result-schema",
      "support-troubleshooting-map",
    ],
  );
  assert.equal(canCreateUpgradeTestSuiteFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateUpgradeTestSuiteFollowUp({ phase: "M2", m0Accepted: false }).allowed, false);
  assert.equal(canCreateUpgradeTestSuiteFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateUpgradeTestSuiteFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects live runner, migration, restore, UI, release, and support implementation creep", () => {
  assert.deepEqual(validateUpgradeTestSuiteScope(UPGRADE_TEST_SUITE_SCOPE), {
    ok: true,
    errors: [],
  });

  for (const [label, sentence] of [
    ["runner", "Build the production upgrade test runner and scheduler."],
    ["migration", "Execute live schema migrations and customer data rewrites."],
    ["restore", "Run live backup restore and rollback operations for tenants."],
    ["ui", "Build the compatibility dashboard and upgrade wizard UI."],
    ["release", "Publish final release notes and approve launch blockers."],
    ["support", "Implement support ticket automation and customer notifications."],
    ["security", "Collect real secrets and scan customer environments during tests."],
  ]) {
    const result = validateUpgradeTestSuiteScope({
      ...UPGRADE_TEST_SUITE_SCOPE,
      scopeIn: [...UPGRADE_TEST_SUITE_SCOPE.scopeIn, sentence],
    });

    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), new RegExp(label, "i"));
  }
});

test("scope validation rejects records missing required evidence fields", () => {
  const result = validateUpgradeTestSuiteScope({
    ...UPGRADE_TEST_SUITE_SCOPE,
    requiredEvidence: UPGRADE_TEST_SUITE_SCOPE.requiredEvidence.filter(
      (evidence) => evidence.id !== "rollback-proof",
    ),
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /rollback-proof/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyUpgradeTestSuiteDecision("define upgrade test suite acceptance evidence"), {
    owner: "Upgrade Test Suite",
    inScope: true,
  });
  assert.equal(
    classifyUpgradeTestSuiteDecision("upgrade migration dry-run engine").owner,
    "Upgrade & Migration Engine",
  );
  assert.equal(
    classifyUpgradeTestSuiteDecision("supported browser compatibility matrix").owner,
    "Compatibility Matrix",
  );
  assert.equal(classifyUpgradeTestSuiteDecision("backup restore drill").owner, "Backup & Restore");
  assert.equal(classifyUpgradeTestSuiteDecision("bootstrap smoke matrix").owner, "Bootstrap Installer");
  assert.equal(classifyUpgradeTestSuiteDecision("release notes publication").owner, "V1 Release Notes & Upgrade Guide");
  assert.equal(classifyUpgradeTestSuiteDecision("security verification waiver").owner, "Security Verification");
  assert.equal(classifyUpgradeTestSuiteDecision("support ticket automation").owner, "Support Workflow");
});
