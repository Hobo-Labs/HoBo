import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BOOTSTRAP_LAUNCH_SMOKE_MATRIX,
  classifyBootstrapLaunchSmokeWork,
  cloneMutableBootstrapLaunchSmokeMatrix,
  summarizeBootstrapLaunchEvidence,
  validateBootstrapLaunchSmokeMatrix,
} from "../src/bootstrap-launch-smoke-matrix.ts";

const REQUIRED_PATHS = ["saas-bootstrap", "self-host-bootstrap", "local-dev-bootstrap"];
const REQUIRED_STAGES = [
  "preflight",
  "auth-seed",
  "first-project",
  "first-deploy",
  "failure-recovery",
  "cleanup-or-uninstall",
];

test("launch smoke matrix covers SaaS, self-host, and local bootstrap stages", () => {
  const result = validateBootstrapLaunchSmokeMatrix(BOOTSTRAP_LAUNCH_SMOKE_MATRIX);

  assert.deepEqual(result.errors, []);
  assert.equal(BOOTSTRAP_LAUNCH_SMOKE_MATRIX.issue, "HOBO-501");
  assert.deepEqual(
    BOOTSTRAP_LAUNCH_SMOKE_MATRIX.paths.map((path) => path.id),
    REQUIRED_PATHS,
  );

  for (const path of BOOTSTRAP_LAUNCH_SMOKE_MATRIX.paths) {
    assert.deepEqual(
      path.stages.map((stage) => stage.id),
      REQUIRED_STAGES,
      `${path.id} must name every launch-smoke stage`,
    );
    assert.ok(path.firstProjectContract, `${path.id} must name first project shape`);
    assert.ok(path.firstDeployContract, `${path.id} must name first deploy shape`);
  }
});

test("each bootstrap path names fixtures, mocked boundaries, and unsupported states", () => {
  for (const path of BOOTSTRAP_LAUNCH_SMOKE_MATRIX.paths) {
    assert.ok(path.fixtures.length >= 3, `${path.id} must name required fixtures`);
    assert.ok(path.mockedBoundaries.length >= 2, `${path.id} must name mocked boundaries`);
    assert.ok(path.unsupportedStates.length >= 2, `${path.id} must name unsupported states`);

    for (const stage of path.stages) {
      assert.ok(stage.fixtureIds.length > 0, `${path.id}/${stage.id} must bind fixture evidence`);
      assert.ok(stage.mockedBoundaryIds.length > 0, `${path.id}/${stage.id} must bind mocked boundaries`);
      assert.ok(stage.resultId, `${path.id}/${stage.id} must feed a named result`);
    }
  }
});

test("self-host bootstrap proof preserves seed Yard, identity handoff, and air-gap constraints", () => {
  const selfHost = BOOTSTRAP_LAUNCH_SMOKE_MATRIX.paths.find((path) => path.id === "self-host-bootstrap");

  assert.ok(selfHost);
  assert.deepEqual(selfHost.seedAuth.allowedScopes, ["bootstrap.seed-yard", "identity.handoff"]);
  assert.equal(selfHost.seedAuth.credentialSource, "single-use operator bootstrap secret fixture");
  assert.equal(selfHost.seedAuth.auditEvent, "BootstrapSeedCredentialObserved");
  assert.equal(selfHost.seedAuth.noAmbientCloudKey, true);
  assert.equal(selfHost.seedAuth.zeroEgressMode, true);
  assert.ok(selfHost.seedAuth.ttlSeconds <= 3600);
});

test("matrix results feed release notes, troubleshooting, and support handoff", () => {
  const summary = summarizeBootstrapLaunchEvidence(BOOTSTRAP_LAUNCH_SMOKE_MATRIX);

  assert.deepEqual(summary.feedTargets, ["release-notes", "troubleshooting", "support-handoff"]);
  assert.ok(summary.releaseNotes.some((entry) => entry.includes("SaaS bootstrap")));
  assert.ok(summary.troubleshooting.some((entry) => entry.includes("unsupported")));
  assert.ok(summary.supportHandoff.some((entry) => entry.includes("setup-stage diagnostics")));
});

test("validation rejects production installer implementation and live-environment creep", () => {
  const invalid = cloneMutableBootstrapLaunchSmokeMatrix();
  invalid.scopeIn.push("Build production installer scripts and publish native packages.");
  invalid.scopeIn.push("Provision live cloud resources and run a real first deploy.");
  invalid.scopeIn.push("Mint production auth seed tokens and persist credentials.");
  invalid.scopeIn.push("Scan customer environments before bootstrap.");
  invalid.scopeIn.push("Implement uninstall cleanup against live resources.");

  const result = validateBootstrapLaunchSmokeMatrix(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /production installer/i);
  assert.match(result.errors.join("\n"), /live cloud provisioning/i);
  assert.match(result.errors.join("\n"), /production auth/i);
  assert.match(result.errors.join("\n"), /customer environment scan/i);
  assert.match(result.errors.join("\n"), /uninstall cleanup implementation/i);
});

test("validation fails closed when required path evidence or result feeds disappear", () => {
  const missingLocal = cloneMutableBootstrapLaunchSmokeMatrix();
  missingLocal.paths = missingLocal.paths.filter((path) => path.id !== "local-dev-bootstrap");

  assert.match(
    validateBootstrapLaunchSmokeMatrix(missingLocal).errors.join("\n"),
    /Missing bootstrap path: local-dev-bootstrap/,
  );

  const missingSupportFeed = cloneMutableBootstrapLaunchSmokeMatrix();
  missingSupportFeed.resultFeeds = missingSupportFeed.resultFeeds.filter((feed) => feed.target !== "support-handoff");

  assert.match(
    validateBootstrapLaunchSmokeMatrix(missingSupportFeed).errors.join("\n"),
    /Missing result feed: support-handoff/,
  );
});

test("work classifier routes adjacent implementation to the owning initiative", () => {
  assert.deepEqual(classifyBootstrapLaunchSmokeWork("launch smoke matrix fixture evidence"), {
    owner: "Bootstrap Installer Launch Smoke Matrix",
    inScope: true,
  });
  assert.deepEqual(classifyBootstrapLaunchSmokeWork("production installer native binary"), {
    owner: "Bootstrap Installer Production Implementation",
    inScope: false,
  });
  assert.deepEqual(classifyBootstrapLaunchSmokeWork("release notes cutline and launch claims"), {
    owner: "V1 Release Program & Cutline",
    inScope: false,
  });
  assert.deepEqual(classifyBootstrapLaunchSmokeWork("support troubleshooting ticket workflow"), {
    owner: "Support Workflow",
    inScope: false,
  });
  assert.deepEqual(classifyBootstrapLaunchSmokeWork("dogfood yard seed handover fixture"), {
    owner: "Dogfood Yard",
    inScope: false,
  });
});
