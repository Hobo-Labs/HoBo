import assert from "node:assert/strict";
import { test } from "vitest";

import {
  badSupervisionFixtures,
  canonicalSupervisionFixtures,
  runSupervisionCase,
  runSupervisionChildLifetimeContract,
  supervisionChildLifetimeSpec,
} from "../src/supervision-child-lifetime.ts";

test("supervision contract publishes stable case names for SDK diagnostics", () => {
  const report = runSupervisionChildLifetimeContract();

  assert.equal(report.suite, "@hobo/conformance/sdk/supervision-child-lifetime");
  assert.equal(report.specVersion, supervisionChildLifetimeSpec.version);
  assert.equal(report.status, "passed");
  assert.deepEqual(
    report.supervisionSemanticsLane.cases.map(({ name, status }) => ({ name, status })),
    [
      { name: "invoked-child-stops-on-parent-exit", status: "passed" },
      { name: "spawned-child-requires-stop-or-teardown", status: "passed" },
      { name: "retry-budget-exhaustion-escalates", status: "passed" },
      { name: "cleanup-failure-is-audited", status: "passed" },
      { name: "replay-reconstructs-supervision-outcome", status: "passed" },
    ],
  );
});

test("parent state exit stops invoked child work and records cleanup facts", () => {
  const result = runSupervisionCase(
    canonicalSupervisionFixtures.find(({ name }) => name === "invoked-child-stops-on-parent-exit")!,
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.provenAcceptance, [
    "parent-exit-stops-invoked-child",
    "cleanup-facts-after-parent-exit",
  ]);
});

test("spawned child work needs explicit stop or teardown ownership", () => {
  const result = runSupervisionCase(
    canonicalSupervisionFixtures.find(({ name }) => name === "spawned-child-requires-stop-or-teardown")!,
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.provenAcceptance, ["spawned-child-has-teardown-owner"]);
});

test("retry budget exhaustion escalates with operator context and survives replay", () => {
  const result = runSupervisionCase(
    canonicalSupervisionFixtures.find(({ name }) => name === "retry-budget-exhaustion-escalates")!,
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.provenAcceptance, ["retry-budget-exhaustion-escalates"]);
});

test("cleanup failure is audited and cannot mark parent successful", () => {
  const result = runSupervisionCase(
    canonicalSupervisionFixtures.find(({ name }) => name === "cleanup-failure-is-audited")!,
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.provenAcceptance, [
    "cleanup-failure-audited",
    "cleanup-failure-not-successful",
  ]);
});

test("replay reconstructs supervision outcome from persisted facts", () => {
  const result = runSupervisionCase(
    canonicalSupervisionFixtures.find(({ name }) => name === "replay-reconstructs-supervision-outcome")!,
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.provenAcceptance, ["replay-reconstructs-outcome"]);
});

test("adversarial fixtures fail with stable refusal codes", () => {
  assert.deepEqual(
    badSupervisionFixtures.map(runSupervisionCase).map(({ name, status, code }) => ({ name, status, code })),
    [
      {
        name: "bad-parent-cancel-leaves-child-retry",
        status: "failed",
        code: "supervision.untracked_child_retry",
      },
      {
        name: "bad-cleanup-trap-without-audit",
        status: "failed",
        code: "supervision.cleanup_not_audited",
      },
      {
        name: "bad-retry-budget-reset-after-restart",
        status: "failed",
        code: "supervision.retry_budget_reset",
      },
    ],
  );
});

test("report composes with HOBO-516 resilience lane instead of replacing it", () => {
  const report = runSupervisionChildLifetimeContract();

  assert.equal(report.resilienceSemanticsLane.status, "referenced");
  assert.match(report.resilienceSemanticsLane.source, /HOBO-516/);
  assert.deepEqual(report.scopeOut, [
    "No distributed scheduler implementation.",
    "No production process supervision tree.",
    "No new queue backend.",
  ]);
});
