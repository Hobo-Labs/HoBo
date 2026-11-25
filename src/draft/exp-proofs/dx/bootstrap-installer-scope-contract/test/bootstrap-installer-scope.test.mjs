import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BOOTSTRAP_INSTALLER_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateBootstrapInstallerFollowUp,
  validateBootstrapInstallerScope,
} from "../src/bootstrap-installer-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateBootstrapInstallerScope(BOOTSTRAP_INSTALLER_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(BOOTSTRAP_INSTALLER_SCOPE.issue, "HOBO-428");
  assert.equal(BOOTSTRAP_INSTALLER_SCOPE.phase, "M0");
  assert.match(BOOTSTRAP_INSTALLER_SCOPE.goal, /bootstrap installer/i);
  assert.match(BOOTSTRAP_INSTALLER_SCOPE.goal, /saas/i);
  assert.match(BOOTSTRAP_INSTALLER_SCOPE.goal, /self-host/i);
  assert.match(BOOTSTRAP_INSTALLER_SCOPE.goal, /local\/dev/i);
  assert.deepEqual(
    BOOTSTRAP_INSTALLER_SCOPE.personas.map((persona) => persona.role),
    [
      "app developer",
      "platform engineer",
      "devops operator",
      "support engineer",
      "security/compliance reviewer",
    ],
  );
  assert.deepEqual(Object.keys(BOOTSTRAP_INSTALLER_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(BOOTSTRAP_INSTALLER_SCOPE.scopeIn.length >= 5);
  assert.ok(BOOTSTRAP_INSTALLER_SCOPE.scopeOut.length >= 6);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    BOOTSTRAP_INSTALLER_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/walkthrough.md",
      "docs/design/dogfood-yard.md",
      "docs/design/adr/01-architecture-core.md#adr-0092",
      "docs/design/adr/07-portability-extensibility.md#adr-0036",
      "docs/design/adr/02-identity-security.md#adr-0008",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    BOOTSTRAP_INSTALLER_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Bootstrap Installer",
      "Dogfood Yard",
      "Identity & Auth",
      "CLI/MCP & Developer Experience",
      "Support Workflow",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    BOOTSTRAP_INSTALLER_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    BOOTSTRAP_INSTALLER_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "install-path-matrix",
      "bootstrap-seed-and-auth-handoff-record",
      "first-project-and-first-deploy-smoke-shape",
      "failure-recovery-and-uninstall-boundary",
      "support-troubleshooting-handoff",
      "security-secret-handling-review",
    ],
  );
  assert.equal(
    BOOTSTRAP_INSTALLER_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateBootstrapInstallerFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateBootstrapInstallerFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateBootstrapInstallerFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateBootstrapInstallerFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects live installer, provisioning, auth, deploy, or cleanup creep", () => {
  const result = validateBootstrapInstallerScope({
    ...BOOTSTRAP_INSTALLER_SCOPE,
    scopeIn: [
      ...BOOTSTRAP_INSTALLER_SCOPE.scopeIn,
      "Implement production installer scripts, live cloud provisioning, account creation, first deploy, and uninstall cleanup.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires proof source for launch-readiness claims", () => {
  const result = validateBootstrapInstallerScope({
    ...BOOTSTRAP_INSTALLER_SCOPE,
    m1Evidence: [
      ...BOOTSTRAP_INSTALLER_SCOPE.m1Evidence,
      {
        kind: "installer-ready-claim",
        owner: "platform engineer",
        proofMode: "contract-test",
        proves: "Bootstrap installer is ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /source/i);
});
