import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertCiFabricContract,
  createHoboCiFabricContract,
  simulateHelloBindleE2e,
  shouldRunHelloBindleE2e,
  validateCiFabricContract,
} from "../src/ci-fabric-contract.js";

test("PR CI blocks on the full local gate including unit and conformance checks", () => {
  const contract = createHoboCiFabricContract();
  const report = assertCiFabricContract(contract);

  assert.equal(report.passed, true);
  assert.deepEqual(report.coverage, [
    "pr.full-suite-blocking",
    "e2e.oidc-secretless",
    "e2e.hello-bindle-live-url",
    "e2e.teardown-and-sweeper",
    "e2e.cost-gated",
    "e2e.quarantine-nonblocking",
    "cache.wasm-oci-artifacts",
  ]);
  assert.deepEqual(contract.workflow.pullRequestGate.requiredChecks, [
    "build",
    "typecheck",
    "lint",
    "unit",
    "conformance",
  ]);
  assert.equal(contract.workflow.pullRequestGate.blocksPullRequest, true);
  assert.deepEqual(contract.workflow.pullRequestGate.commands, [
    "pnpm install --frozen-lockfile --config.confirmModulesPurge=false",
    "pnpm run lint:code",
    "pnpm agent:check -- --base=origin/main",
    "pnpm exec turbo run build typecheck lint test:unit test:schema test:contract:consumer",
    "pnpm run build:packages",
  ]);
});

test("hello-bindle E2E uses keyless OIDC, asserts the live URL, and tears down", () => {
  const contract = createHoboCiFabricContract();
  const run = simulateHelloBindleE2e(contract, {
    githubRunId: "run-100",
    liveUrl: "https://hello-bindle.run-100.sandbox.hobo.dev",
  });

  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.events.map((event) => event.type),
    [
      "oidc.TokenRequested",
      "sandbox.TokenGranted",
      "hobo.UpStarted",
      "hobo.LiveUrlAsserted",
      "hobo.DownStarted",
      "hobo.OrphanSweepCompleted",
    ],
  );
  assert.equal(run.cleanup.teardownAttempted, true);
  assert.equal(run.cleanup.orphanSweeperRan, true);
  assert.equal(run.deployment.fixture, "examples/hello-bindle");
  assert.equal(run.deployment.liveUrl, "https://hello-bindle.run-100.sandbox.hobo.dev");
  assert.equal(run.token.secretSource, undefined);
  assert.deepEqual(run.token.scopes, ["deployments:create", "deployments:read", "deployments:delete"]);
});

test("cost guard keeps E2E behind a label, schedule, or manual dispatch", () => {
  const contract = createHoboCiFabricContract();

  assert.equal(shouldRunHelloBindleE2e(contract, { eventName: "pull_request", labels: [] }), false);
  assert.equal(
    shouldRunHelloBindleE2e(contract, { eventName: "pull_request", labels: ["hobo/e2e"] }),
    true,
  );
  assert.equal(shouldRunHelloBindleE2e(contract, { eventName: "schedule", labels: [] }), true);
  assert.equal(shouldRunHelloBindleE2e(contract, { eventName: "workflow_dispatch", labels: [] }), true);
});

test("teardown and orphan sweep run even when the live URL assertion fails", () => {
  const contract = createHoboCiFabricContract();
  const run = simulateHelloBindleE2e(contract, {
    githubRunId: "run-101",
    failAt: "assert-live-url",
  });

  assert.equal(run.status, "failed");
  assert.equal(run.failure.code, "live-url-unreachable");
  assert.deepEqual(
    run.events.map((event) => event.type),
    [
      "oidc.TokenRequested",
      "sandbox.TokenGranted",
      "hobo.UpStarted",
      "hobo.LiveUrlAsserted",
      "hobo.DownStarted",
      "hobo.OrphanSweepCompleted",
    ],
  );
  assert.equal(run.cleanup.teardownAttempted, true);
  assert.equal(run.cleanup.orphanSweeperRan, true);
});

test("OIDC trust fails closed when the sandbox role is over-broad", () => {
  const report = validateCiFabricContract(
    createHoboCiFabricContract({
      e2e: {
        auth: {
          cloudRole: {
            allowedActions: ["deployments:*", "iam:*"],
          },
        },
      },
    }),
  );

  assert.equal(report.passed, false);
  assert.deepEqual(report.violations, [
    {
      code: "oidc.role.overbroad",
      message: "sandbox role grants forbidden or wildcard actions: deployments:*, iam:*",
    },
  ]);
});

test("stored cloud secrets are rejected; CI must use the OIDC token broker", () => {
  const report = validateCiFabricContract(
    createHoboCiFabricContract({
      e2e: {
        env: {
          AWS_SECRET_ACCESS_KEY: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
        },
      },
    }),
  );

  assert.equal(report.passed, false);
  assert.deepEqual(report.violations, [
    {
      code: "oidc.stored-secret",
      message: "E2E environment references stored secrets: AWS_SECRET_ACCESS_KEY",
    },
  ]);
});

test("missing teardown or orphan sweeper fails the E2E contract", () => {
  const report = validateCiFabricContract(
    createHoboCiFabricContract({
      e2e: {
        teardown: {
          always: false,
          orphanSweeper: { enabled: false },
        },
      },
    }),
  );

  assert.equal(report.passed, false);
  assert.deepEqual(report.violations, [
    {
      code: "e2e.teardown.not-always",
      message: "hello-bindle teardown must run with if: always() semantics",
    },
    {
      code: "e2e.orphan-sweeper.missing",
      message: "hello-bindle E2E must include an orphan sweeper for failed runs",
    },
  ]);
});

test("flaky E2E runs have a non-blocking quarantine lane", () => {
  const report = validateCiFabricContract(
    createHoboCiFabricContract({
      e2e: {
        quarantine: {
          continueOnError: false,
        },
      },
    }),
  );

  assert.equal(report.passed, false);
  assert.deepEqual(report.violations, [
    {
      code: "e2e.quarantine.blocks",
      message: "quarantine E2E lane must not block PR merges",
    },
  ]);
});

test("wasm and OCI build artifacts are cached independently", () => {
  const report = validateCiFabricContract(
    createHoboCiFabricContract({
      workflow: {
        artifactCache: {
          entries: [{ kind: "wasm", path: "~/.cache/hobo/wasm" }],
        },
      },
    }),
  );

  assert.equal(report.passed, false);
  assert.deepEqual(report.violations, [
    {
      code: "cache.oci.missing",
      message: "CI cache must include OCI build artifacts",
    },
  ]);
});
