import assert from "node:assert/strict";
import { test } from "vitest";

import { createRunInspectorProjection } from "../src/run-inspector.js";

test("completed run renders step, saga, and actor timeline with memoized replay results", () => {
  const projection = createRunInspectorProjection(completedRunEvents());

  const view = projection.inspectRun("run-264");

  assert.equal(view.status, "completed");
  assert.equal(view.partial, false);
  assert.deepEqual(
    view.steps.items.map((step) => [step.id, step.status, step.attempts, step.durationMs]),
    [
      ["plan", "completed", 1, 12],
      ["apply", "completed", 2, 55],
    ],
  );
  assert.deepEqual(view.steps.items[0].input, { manifest: "bindle-a" });
  assert.deepEqual(view.steps.items[0].output, { planId: "plan-a" });
  assert.deepEqual(view.steps.items[0].memoizedResult, { planId: "plan-a" });
  assert.equal(view.sagas[0].id, "deploy-saga");
  assert.equal(view.sagas[0].status, "completed");
  assert.equal(view.actors[0].id, "resource:api");
  assert.equal(view.actors[0].status, "passivated");
  assert.deepEqual(
    view.timeline.map((entry) => entry.type),
    [
      "run.Started",
      "run.StepStarted",
      "run.StepCompleted",
      "actor.Activated",
      "saga.Started",
      "run.StepStarted",
      "run.StepRetried",
      "run.StepCompleted",
      "saga.Completed",
      "actor.Passivated",
      "run.Completed",
    ],
  );
});

test("time travel reproduces historical state as of a specific event sequence", () => {
  const projection = createRunInspectorProjection(completedRunEvents());

  const view = projection.inspectRun("run-264", { atSeq: 6 });

  assert.equal(view.status, "in-flight");
  assert.equal(view.partial, true);
  assert.deepEqual(
    view.steps.items.map((step) => [step.id, step.status]),
    [
      ["plan", "completed"],
      ["apply", "running"],
    ],
  );
  assert.equal(view.timeline.at(-1).id, "evt-6");
});

test("replay diff flags changed output, signature mismatches, and unchanged memoized output", () => {
  const projection = createRunInspectorProjection(completedRunEvents());

  const diff = projection.replayDiff("run-264", [
    { stepId: "plan", signature: "plan(input:v1)", output: { planId: "plan-a" } },
    { stepId: "apply", signature: "apply(input:v2)", output: { resourceId: "api-2" } },
  ]);

  assert.equal(diff.status, "changed");
  assert.deepEqual(
    diff.diffs.map((entry) => [entry.stepId, entry.status]),
    [
      ["plan", "unchanged"],
      ["apply", "signature-mismatch"],
    ],
  );

  const changedOutput = projection.replayDiff("run-264", [
    { stepId: "plan", signature: "plan(input:v1)", output: { planId: "plan-b" } },
    { stepId: "apply", signature: "apply(input:v1)", output: { resourceId: "api-1" } },
  ]);
  assert.equal(changedOutput.diffs[0].status, "changed");
  assert.equal(changedOutput.diffs[1].status, "unchanged");
});

test("causality links each event to the event or external command that caused it", () => {
  const projection = createRunInspectorProjection(completedRunEvents());

  const view = projection.inspectRun("run-264");

  assert.deepEqual(view.causality.slice(0, 3), [
    { from: "cmd-1", to: "evt-1", type: "external" },
    { from: "evt-1", to: "evt-2", type: "event" },
    { from: "evt-2", to: "evt-3", type: "event" },
  ]);
  assert.deepEqual(view.steps.items[1].causality.at(-1), { from: "evt-7", to: "evt-8" });
});

test("large runs are paginated without losing total step count", () => {
  const events = [
    event(1, "run.Started", { runId: "run-large" }, { causationId: "cmd-large" }),
    ...Array.from({ length: 1005 }, (_, index) =>
      event(index + 2, "run.StepCompleted", {
        runId: "run-large",
        stepId: `step-${String(index).padStart(4, "0")}`,
        attempts: 1,
        output: { index },
      }),
    ),
  ];
  const projection = createRunInspectorProjection(events);

  const firstPage = projection.inspectRun("run-large", { pageSize: 100 });
  const secondPage = projection.inspectRun("run-large", {
    pageSize: 100,
    cursor: firstPage.steps.nextCursor,
  });

  assert.equal(firstPage.steps.total, 1005);
  assert.equal(firstPage.steps.items.length, 100);
  assert.equal(firstPage.steps.nextCursor, 100);
  assert.equal(secondPage.steps.items[0].id, "step-0100");
});

test("in-flight runs inspect honestly without requiring completion", () => {
  const projection = createRunInspectorProjection([
    event(1, "run.Started", { runId: "run-live" }, { causationId: "cmd-live" }),
    event(2, "run.StepStarted", {
      runId: "run-live",
      stepId: "apply",
      attempts: 1,
      input: { deployment: "d1" },
    }),
  ]);

  const view = projection.inspectRun("run-live");

  assert.equal(view.status, "in-flight");
  assert.equal(view.partial, true);
  assert.deepEqual(view.steps.items, [
    {
      id: "apply",
      status: "running",
      attempts: 1,
      input: { deployment: "d1" },
      output: undefined,
      memoizedResult: undefined,
      memoizedDigest: undefined,
      durationMs: undefined,
      signature: undefined,
      firstSeq: 2,
      lastSeq: 2,
      causality: [{ from: "evt-1", to: "evt-2" }],
    },
  ]);
});

function completedRunEvents() {
  return [
    event(1, "run.Started", { runId: "run-264" }, { causationId: "cmd-1" }),
    event(2, "run.StepStarted", {
      runId: "run-264",
      stepId: "plan",
      attempts: 1,
      input: { manifest: "bindle-a" },
      signature: "plan(input:v1)",
    }),
    event(3, "run.StepCompleted", {
      runId: "run-264",
      stepId: "plan",
      attempts: 1,
      durationMs: 12,
      output: { planId: "plan-a" },
      memoizedResult: { planId: "plan-a" },
      signature: "plan(input:v1)",
    }),
    event(4, "actor.Activated", { actorId: "resource:api", runId: "run-264" }),
    event(5, "saga.Started", { sagaId: "deploy-saga", runId: "run-264" }),
    event(6, "run.StepStarted", {
      runId: "run-264",
      stepId: "apply",
      attempts: 1,
      input: { planId: "plan-a" },
      signature: "apply(input:v1)",
    }),
    event(7, "run.StepRetried", { runId: "run-264", stepId: "apply", attempt: 2 }),
    event(8, "run.StepCompleted", {
      runId: "run-264",
      stepId: "apply",
      attempts: 2,
      durationMs: 55,
      output: { resourceId: "api-1" },
      memoizedResult: { resourceId: "api-1" },
      signature: "apply(input:v1)",
    }),
    event(9, "saga.Completed", { sagaId: "deploy-saga", runId: "run-264" }),
    event(10, "actor.Passivated", { actorId: "resource:api", runId: "run-264" }),
    event(11, "run.Completed", { runId: "run-264" }),
  ];
}

function event(seq, type, data, options = {}) {
  return {
    id: `evt-${seq}`,
    seq,
    type,
    ts: `2026-06-26T09:${String(seq).padStart(2, "0")}:00.000Z`,
    correlationId: data.runId,
    causationId: options.causationId ?? (seq === 1 ? undefined : `evt-${seq - 1}`),
    data,
  };
}
