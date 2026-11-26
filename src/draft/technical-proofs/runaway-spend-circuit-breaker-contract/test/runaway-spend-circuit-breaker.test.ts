import assert from "node:assert/strict";
import { test } from "vitest";

import {
  evaluateRunawaySpendCircuitBreaker,
  replaySpendCircuitEvents,
} from "../src/runaway-spend-circuit-breaker.js";

const BASE_TIME = "2026-06-26T12:00:00.000Z";

function policy(overrides = {}) {
  return {
    id: "spend-breaker:camp-prod",
    scope: { kind: "camp", id: "tenant-a/camp-prod" },
    velocityThresholdUsdPerHour: 50,
    debounce: {
      minSamples: 3,
      minDurationSeconds: 120,
      windowSeconds: 300,
      maxSampleAgeSeconds: 300,
    },
    minResetIntervalSeconds: 600,
    halfOpenProbeLimit: 1,
    ...overrides,
  };
}

function meteringView(overrides = {}) {
  return {
    view: "MeteringView",
    seq: 42,
    digest: "metering-digest-42",
    currency: "USD",
    ...overrides,
  };
}

function sample(id, observedAt, spendVelocityUsdPerHour, overrides = {}) {
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    observedAt,
    spendVelocityUsdPerHour,
    degradationExhausted: true,
    ...overrides,
  };
}

function spikeSamples() {
  return [
    sample("sample-1", "2026-06-26T11:56:00.000Z", 55),
    sample("sample-2", "2026-06-26T11:58:00.000Z", 62),
    sample("sample-3", BASE_TIME, 78),
  ];
}

function spendAction(overrides = {}) {
  return {
    id: "action:deploy-checkout-prod",
    kind: "hobo:deployment:apply",
    spendIncurring: true,
    ...overrides,
  };
}

function tripBreaker() {
  return evaluateRunawaySpendCircuitBreaker({
    policy: policy(),
    meteringView: meteringView(),
    samples: spikeSamples(),
    action: spendAction(),
    now: BASE_TIME,
  });
}

test("sustained spend spike trips durable breaker and denies spend action", () => {
  const result = tripBreaker();

  assert.equal(result.state.status, "open");
  assert.equal(result.decision.effect, "deny");
  assert.equal(result.decision.reason, "spend circuit open; spend-incurring action halted");

  const event = result.events.find((candidate) => candidate.type === "spend.CircuitTripped");
  assert.equal(event.policyId, "spend-breaker:camp-prod");
  assert.equal(event.meteringViewSeq, 42);
  assert.equal(event.meteringViewDigest, "metering-digest-42");
  assert.deepEqual(event.evidenceSampleIds, ["sample-1", "sample-2", "sample-3"]);
  assert.equal(event.lastResort, true);
  assert.equal(result.decision.obligations[0].kind, "spend.circuit-breaker-halt");
});

test("operator ack after cooldown emits CircuitReset and reopens spend actions", () => {
  const tripped = tripBreaker();
  const result = evaluateRunawaySpendCircuitBreaker({
    policy: policy(),
    meteringView: meteringView({ seq: 50, digest: "metering-digest-50" }),
    eventLog: tripped.events,
    samples: [
      sample("sample-4", "2026-06-26T12:11:00.000Z", 10, { seq: 50 }),
      sample("sample-5", "2026-06-26T12:12:00.000Z", 12, { seq: 51 }),
      sample("sample-6", "2026-06-26T12:13:00.000Z", 8, { seq: 52 }),
    ],
    ack: {
      id: "ack:finance-admin",
      acknowledgedBy: "user:finance-admin",
      acknowledgedAt: "2026-06-26T12:11:00.000Z",
    },
    action: spendAction({ id: "action:generation-resume", kind: "hobo:generation:run" }),
    now: "2026-06-26T12:13:00.000Z",
  });

  assert.equal(result.state.status, "closed");
  assert.equal(result.decision.effect, "allow");
  assert.equal(result.decision.reason, "spend circuit closed");
  assert.equal(result.events.find((event) => event.type === "spend.CircuitReset").ackId, "ack:finance-admin");
});

test("replay reconstructs open breaker after restart and blocks spend", () => {
  const tripped = tripBreaker();
  const replayed = replaySpendCircuitEvents(tripped.events);
  const afterRestart = evaluateRunawaySpendCircuitBreaker({
    policy: policy(),
    meteringView: meteringView({ seq: 43, digest: "metering-digest-43" }),
    eventLog: tripped.events,
    samples: [],
    action: spendAction({ id: "action:provision-agent", kind: "hobo:agent:provision" }),
    now: "2026-06-26T12:04:00.000Z",
  });

  assert.equal(replayed.state.status, "open");
  assert.equal(replayed.state.openEventId, tripped.events[0].id);
  assert.equal(afterRestart.state.status, "open");
  assert.equal(afterRestart.decision.effect, "deny");
  assert.equal(afterRestart.decision.blockedByEventId, tripped.events[0].id);
});

test("non-spend actions proceed while breaker is open", () => {
  const tripped = tripBreaker();
  const result = evaluateRunawaySpendCircuitBreaker({
    policy: policy(),
    meteringView: meteringView({ seq: 44, digest: "metering-digest-44" }),
    eventLog: tripped.events,
    samples: [],
    action: {
      id: "action:read-status",
      kind: "hobo:status:read",
      spendIncurring: false,
    },
    now: "2026-06-26T12:03:00.000Z",
  });

  assert.equal(result.state.status, "open");
  assert.equal(result.decision.effect, "allow");
  assert.equal(result.decision.reason, "spend circuit open; action is not spend-incurring");
});

test("single burst and stale metering samples do not trip breaker", () => {
  const burst = evaluateRunawaySpendCircuitBreaker({
    policy: policy(),
    meteringView: meteringView(),
    samples: [sample("sample-1", BASE_TIME, 95)],
    action: spendAction(),
    now: BASE_TIME,
  });
  const stale = evaluateRunawaySpendCircuitBreaker({
    policy: policy(),
    meteringView: meteringView({ seq: 43, digest: "metering-digest-43" }),
    samples: [
      sample("sample-1", "2026-06-26T11:40:00.000Z", 95),
      sample("sample-2", "2026-06-26T11:42:00.000Z", 96),
      sample("sample-3", "2026-06-26T11:44:00.000Z", 97),
    ],
    action: spendAction(),
    now: BASE_TIME,
  });

  assert.equal(burst.state.status, "closed");
  assert.equal(burst.decision.effect, "allow");
  assert.equal(burst.events.length, 0);
  assert.equal(stale.state.status, "closed");
  assert.equal(stale.evaluations[0].staleMeteringSamples, true);
  assert.equal(stale.events.length, 0);
});

test("degradation must be exhausted before breaker trips", () => {
  const result = evaluateRunawaySpendCircuitBreaker({
    policy: policy(),
    meteringView: meteringView(),
    samples: spikeSamples().map((entry) => ({ ...entry, degradationExhausted: false })),
    action: spendAction(),
    now: BASE_TIME,
  });

  assert.equal(result.state.status, "closed");
  assert.equal(result.decision.effect, "allow");
  assert.equal(result.evaluations[0].degradationRequiredBeforeTrip, true);
});

test("compensation actions bypass the halt while the breaker is open", () => {
  const tripped = tripBreaker();
  const result = evaluateRunawaySpendCircuitBreaker({
    policy: policy(),
    meteringView: meteringView({ seq: 45, digest: "metering-digest-45" }),
    eventLog: tripped.events,
    samples: [],
    action: {
      id: "action:compensate-resource",
      kind: "hobo:deployment:compensate",
      spendIncurring: true,
      compensation: true,
    },
    now: "2026-06-26T12:05:00.000Z",
  });

  assert.equal(result.state.status, "open");
  assert.equal(result.decision.effect, "allow");
  assert.equal(result.decision.reason, "spend circuit open; in-flight compensation remains allowed");
});

test("cooldown prevents reset flapping", () => {
  const tripped = tripBreaker();
  const result = evaluateRunawaySpendCircuitBreaker({
    policy: policy({ minResetIntervalSeconds: 900 }),
    meteringView: meteringView({ seq: 46, digest: "metering-digest-46" }),
    eventLog: tripped.events,
    samples: [sample("sample-4", "2026-06-26T12:05:00.000Z", 5, { seq: 46 })],
    ack: {
      id: "ack:too-soon",
      acknowledgedBy: "user:finance-admin",
      acknowledgedAt: "2026-06-26T12:05:00.000Z",
    },
    action: spendAction({ id: "action:retry-deploy" }),
    now: "2026-06-26T12:05:00.000Z",
  });

  assert.equal(result.state.status, "open");
  assert.equal(result.decision.effect, "deny");
  assert.equal(result.events.length, 0);
  assert.equal(result.evaluations.find((entry) => entry.kind === "spend-circuit-reset").reason, "reset cooldown not elapsed");
});

test("ack racing a fresh spike fails closed without reset", () => {
  const tripped = tripBreaker();
  const result = evaluateRunawaySpendCircuitBreaker({
    policy: policy({ minResetIntervalSeconds: 60 }),
    meteringView: meteringView({ seq: 55, digest: "metering-digest-55" }),
    eventLog: tripped.events,
    samples: [
      sample("sample-4", "2026-06-26T12:11:00.000Z", 10, { seq: 50 }),
      sample("sample-5", "2026-06-26T12:12:00.000Z", 88, { seq: 51 }),
    ],
    ack: {
      id: "ack:raced",
      acknowledgedBy: "user:finance-admin",
      acknowledgedAt: "2026-06-26T12:11:30.000Z",
    },
    action: spendAction({ id: "action:retry-generation", kind: "hobo:generation:run" }),
    now: "2026-06-26T12:12:00.000Z",
  });

  assert.equal(result.state.status, "open");
  assert.equal(result.decision.effect, "deny");
  assert.equal(result.events.length, 0);
  assert.equal(result.evaluations.find((entry) => entry.kind === "spend-circuit-reset").reason, "ack raced fresh spend spike");
});
