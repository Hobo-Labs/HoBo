import assert from "node:assert/strict";
import { test } from "vitest";

import {
  badResilienceFixtures,
  canonicalResilienceFixtures,
  resilienceSemanticsSpec,
  runResilienceSemanticsAnnex,
} from "../src/resilience-semantics-annex.mjs";

test("resilience annex emits stable case names for the later SDK conformance lane", () => {
  const report = runResilienceSemanticsAnnex(canonicalResilienceFixtures);

  assert.equal(report.suite, "@hobo/conformance/sdk/resilience-semantics-annex");
  assert.equal(report.specVersion, resilienceSemanticsSpec.version);
  assert.deepEqual(report.goldenIrLane, {
    status: "not-owned",
    source: "HOBO-32 sdk-idiom-conformance-gate",
  });
  assert.deepEqual(report.existingSemanticsLane, {
    status: "referenced",
    source: "HOBO-31 idiom-semantics-annex",
  });
  assert.deepEqual(
    report.resilienceSemanticsLane.cases.map(({ name, status }) => ({ name, status })),
    [
      { name: "transient-retry-schedule", status: "passed" },
      { name: "denial-never-retries", status: "passed" },
      { name: "terminal-never-retries", status: "passed" },
      { name: "cancellation-stops-retry", status: "passed" },
      { name: "deadline-escalates-from-state", status: "passed" },
      { name: "cleanup-after-interruption", status: "passed" },
      { name: "replay-no-effect-rerun", status: "passed" },
      { name: "lifecycle-transition-table", status: "passed" },
      { name: "lifecycle-replay-hydration", status: "passed" },
      { name: "lifecycle-event-derived-inspection", status: "passed" },
      { name: "terminal-duplicate-no-second-side-effect", status: "passed" },
      { name: "child-lifecycle-requires-spawn-contract", status: "passed" },
    ],
  );
  assert.deepEqual(report.unsupportedBehavior, [
    "No Effect dependency or public scheduler API.",
    "No XState dependency or generic statechart runtime.",
    "No production @hobo/conformance package mutation in this proof.",
  ]);
});

test("resilience annex fails bad fixtures with precise stable codes", () => {
  const report = runResilienceSemanticsAnnex(badResilienceFixtures);

  assert.equal(report.status, "failed");
  assert.deepEqual(
    report.resilienceSemanticsLane.cases.map(({ name, status, code }) => ({ name, status, code })),
    [
      { name: "bad-retrying-denial", status: "failed", code: "resilience.denial_retried" },
      { name: "bad-retrying-terminal", status: "failed", code: "resilience.terminal_retried" },
      { name: "bad-hidden-cancellation-retry", status: "failed", code: "resilience.cancellation_retried" },
      { name: "bad-missed-deadline-escalation", status: "failed", code: "resilience.deadline_not_escalated" },
      { name: "bad-skipped-cleanup", status: "failed", code: "resilience.cleanup_missing" },
      { name: "bad-replay-reruns-effects", status: "failed", code: "resilience.replay_reran_effect" },
      { name: "bad-illegal-lifecycle-transition", status: "failed", code: "lifecycle.illegal_transition" },
      { name: "bad-snapshot-without-causative-event", status: "failed", code: "lifecycle.snapshot_without_causative_event" },
      { name: "bad-terminal-duplicate-side-effect", status: "failed", code: "lifecycle.terminal_duplicate_side_effect" },
      { name: "bad-child-outlives-parent", status: "failed", code: "lifecycle.child_outlived_parent" },
    ],
  );
});

test("deadline escalation is proven from persisted state without a fresh command attempt", () => {
  const fixture = canonicalResilienceFixtures.find(
    (entry) => entry.name === "deadline-escalates-from-state",
  );
  const deadline = fixture.facts.find((fact) => fact.type === "deadline.Expired");

  assert.equal(
    fixture.facts.some((fact) => fact.type === "effect.Attempted" && fact.atMs > deadline.atMs),
    false,
  );
  assert.deepEqual(
    runResilienceSemanticsAnnex([fixture]).resilienceSemanticsLane.cases.at(0),
    {
      name: "deadline-escalates-from-state",
      category: "resilienceSemanticsLane",
      status: "passed",
      code: undefined,
      reason: undefined,
    },
  );
});

test("lifecycle transition-table vectors are published as stable conformance cases", () => {
  const report = runResilienceSemanticsAnnex(canonicalResilienceFixtures);

  assert.deepEqual(
    report.resilienceSemanticsLane.cases.slice(-5).map(({ name, status }) => ({ name, status })),
    [
      { name: "lifecycle-transition-table", status: "passed" },
      { name: "lifecycle-replay-hydration", status: "passed" },
      { name: "lifecycle-event-derived-inspection", status: "passed" },
      { name: "terminal-duplicate-no-second-side-effect", status: "passed" },
      { name: "child-lifecycle-requires-spawn-contract", status: "passed" },
    ],
  );
});
