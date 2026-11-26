import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createIdempotencyLedger,
  createSagaEngine,
  makeSagaEvent,
  replaySagaEvents,
} from "../src/choreography-saga-engine.js";

function deterministicEngine(options = {}) {
  let nextId = 1;

  return createSagaEngine({
    now: () => "2026-06-25T00:00:00.000Z",
    idFactory: (prefix) => `${prefix}-${nextId++}`,
    ...options,
  });
}

test("runs a 3-step saga to Completed and reconstructs it from events", async () => {
  const engine = deterministicEngine();

  const outcome = await engine.runSaga({
    sagaId: "saga-three-step",
    tenantId: "tenant-a",
    correlationId: "corr-three-step",
    causationId: "deployment-command-1",
    steps: [
      { id: "plan", run: () => ({ planId: "plan-1" }) },
      { id: "provision", run: () => ({ resourceId: "vm-1" }) },
      { id: "verify", run: () => ({ healthy: true }) },
    ],
  });

  assert.equal(outcome.state.status, "completed");
  assert.deepEqual(outcome.state.completedStepIds, ["plan", "provision", "verify"]);
  assert.deepEqual(
    outcome.events.map((event) => event.type),
    [
      "saga.Started",
      "saga.StepCompleted",
      "saga.StepCompleted",
      "saga.StepCompleted",
      "saga.Completed",
    ],
  );
  assert.ok(outcome.events.every((event) => event.correlationId === "corr-three-step"));
  assert.equal(outcome.events[0].causationId, "deployment-command-1");
  for (let index = 1; index < outcome.events.length; index += 1) {
    assert.equal(outcome.events[index].causationId, outcome.events[index - 1].id);
  }

  const reconstructed = replaySagaEvents(outcome.events);
  assert.equal(reconstructed.state.status, "completed");
  assert.deepEqual(reconstructed.state.results.verify, { healthy: true });
});

test("replay returns memoized step results without re-executing side effects", async () => {
  const engine = deterministicEngine();
  let firstRunExecutions = 0;
  let replayExecutions = 0;

  const original = await engine.runSaga({
    sagaId: "saga-replay",
    tenantId: "tenant-a",
    correlationId: "corr-replay",
    steps: [
      {
        id: "provision",
        run: () => {
          firstRunExecutions += 1;
          return { resourceId: "db-1" };
        },
      },
    ],
  });

  const replay = await engine.runSaga({
    sagaId: "saga-replay",
    tenantId: "tenant-a",
    correlationId: "corr-replay",
    eventLog: original.events,
    steps: [
      {
        id: "provision",
        run: () => {
          replayExecutions += 1;
          throw new Error("replay must not call the provider");
        },
      },
    ],
  });

  assert.equal(firstRunExecutions, 1);
  assert.equal(replayExecutions, 0);
  assert.equal(replay.state.status, "completed");
  assert.deepEqual(replay.state.results.provision, { resourceId: "db-1" });
});

test("forced failure crosses the no-go threshold and enters compensation", async () => {
  const engine = deterministicEngine();

  const outcome = await engine.runSaga({
    sagaId: "saga-fail",
    tenantId: "tenant-a",
    correlationId: "corr-fail",
    steps: [
      { id: "plan", run: () => ({ planId: "plan-1" }) },
      {
        id: "provision",
        run: () => {
          const error = new Error("provider rejected malformed plan");
          error.code = "MALFORMED_PLAN";
          throw error;
        },
      },
      { id: "verify", run: () => ({ healthy: true }) },
    ],
  });

  assert.equal(outcome.state.status, "rolled-back");
  assert.deepEqual(
    outcome.events.map((event) => event.type),
    [
      "saga.Started",
      "saga.StepCompleted",
      "saga.StepFailed",
      "saga.Compensating",
      "saga.RolledBack",
    ],
  );
  assert.equal(outcome.state.failure.failureClass, "poison");
  const compensating = outcome.events.find((event) => event.type === "saga.Compensating");
  assert.equal(compensating.data.compensation.seam, "stub");
  assert.equal(compensating.data.noGoThreshold.kind, "any-fatal");
});

test("lost StepCompleted append is retried through idempotency memoization", async () => {
  const eventLog = [];
  const ledger = createIdempotencyLedger();
  const engine = deterministicEngine({ ledger });
  let droppedCompletion = false;
  let providerExecutions = 0;

  const appendWithOneLostCompletion = (event) => {
    if (
      event.type === "saga.StepCompleted" &&
      event.data.stepId === "provision" &&
      droppedCompletion === false
    ) {
      droppedCompletion = true;
      return { appended: false, reason: "simulated-lost-append" };
    }

    eventLog.push(event);
    return { appended: true };
  };

  const firstAttempt = await engine.runSaga({
    sagaId: "saga-lost-append",
    tenantId: "tenant-a",
    correlationId: "corr-lost-append",
    eventLog,
    appendEvent: appendWithOneLostCompletion,
    steps: [
      {
        id: "provision",
        idempotencyKey: "provider:tenant-a:provision",
        run: () => {
          providerExecutions += 1;
          return { resourceId: "db-1" };
        },
      },
    ],
  });

  assert.equal(firstAttempt.state.status, "waiting-for-retry");
  assert.equal(providerExecutions, 1);
  assert.equal(eventLog.some((event) => event.type === "saga.StepCompleted"), false);

  const retry = await engine.runSaga({
    sagaId: "saga-lost-append",
    tenantId: "tenant-a",
    correlationId: "corr-lost-append",
    eventLog,
    appendEvent: (event) => {
      eventLog.push(event);
      return { appended: true };
    },
    steps: [
      {
        id: "provision",
        idempotencyKey: "provider:tenant-a:provision",
        run: () => {
          providerExecutions += 1;
          return { resourceId: "db-1" };
        },
      },
    ],
  });

  assert.equal(providerExecutions, 1);
  assert.equal(retry.state.status, "completed");
  assert.deepEqual(retry.state.results.provision, { resourceId: "db-1" });
});

test("stale actor lease is rejected before a racing actor can run the same step", async () => {
  const engine = deterministicEngine();
  const startedEvent = makeSagaEvent({
    id: "evt-started",
    type: "saga.Started",
    sagaId: "saga-race",
    tenantId: "tenant-a",
    correlationId: "corr-race",
    causationId: "deployment-command-1",
    data: { stepIds: ["provision"] },
  });

  const winner = await engine.runSaga({
    sagaId: "saga-race",
    tenantId: "tenant-a",
    correlationId: "corr-race",
    eventLog: [startedEvent],
    lease: { ownerId: "actor-a", fenceToken: 8, currentFenceToken: 8 },
    steps: [{ id: "provision", run: () => ({ resourceId: "vm-1" }) }],
  });

  assert.equal(winner.state.status, "completed");
  await assert.rejects(
    () =>
      engine.runSaga({
        sagaId: "saga-race",
        tenantId: "tenant-a",
        correlationId: "corr-race",
        eventLog: [startedEvent],
        lease: { ownerId: "actor-b", fenceToken: 7, currentFenceToken: 8 },
        steps: [{ id: "provision", run: () => ({ resourceId: "vm-2" }) }],
      }),
    /stale saga lease/i,
  );
});

test("events for an already rolled-back saga are ignored", async () => {
  const engine = deterministicEngine();

  const failed = await engine.runSaga({
    sagaId: "saga-terminal",
    tenantId: "tenant-a",
    correlationId: "corr-terminal",
    steps: [
      {
        id: "provision",
        run: () => {
          const error = new Error("split brain lease");
          error.code = "STALE_FENCE_REJECTED";
          throw error;
        },
      },
    ],
  });

  const lateCompletion = makeSagaEvent({
    id: "evt-late",
    type: "saga.StepCompleted",
    sagaId: "saga-terminal",
    tenantId: "tenant-a",
    correlationId: "corr-terminal",
    causationId: "actor-late",
    data: {
      stepId: "provision",
      result: { resourceId: "late-vm" },
      idempotencyKey: "provider:late",
    },
  });

  const replay = replaySagaEvents([...failed.events, lateCompletion]);

  assert.equal(replay.state.status, "rolled-back");
  assert.equal(replay.ignoredEvents.length, 1);
  assert.equal(replay.ignoredEvents[0].event.id, "evt-late");
  assert.equal(replay.ignoredEvents[0].reason, "terminal-saga");
});
