import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  CHAOS_EVENT_TYPES,
  orchestrateChaosExperiment,
  replayChaosExperiment,
} from "../src/chaos-experiment-orchestration.js";

describe("chaos experiment orchestration contract", () => {
  it("injects a bounded fault and aborts on steady-state breach", async () => {
    const injector = recordingFaultInjector();
    const result = await orchestrateChaosExperiment({
      experiment: checkoutLatencyExperiment(),
      policyBudget: allowProdChaosBudget(),
      lane: signedLane(),
      now: sequentialClock("2026-06-27T20:00:00.000Z"),
      injector,
      steadyStateCheck: ({ phase }) =>
        phase === "after-fault"
          ? { status: "breached", invariant: "checkout-p95-under-250ms", observed: 900 }
          : { status: "healthy", invariant: "checkout-p95-under-250ms", observed: 120 },
    });

    assert.equal(result.status, "aborted");
    assert.deepEqual(
      result.events.map((event) => event.type),
      [
        "policy.Decided",
        CHAOS_EVENT_TYPES.experimentStarted,
        CHAOS_EVENT_TYPES.faultInjected,
        CHAOS_EVENT_TYPES.steadyStateChecked,
        CHAOS_EVENT_TYPES.aborted,
      ],
    );
    assert.deepEqual(
      result.events
        .filter((event) => event.streamId === "chaos:chaos-checkout-latency")
        .map((event) => event.seq),
      [1, 2, 3, 4],
    );
    assert.deepEqual(injector.commands, [
      {
        kind: "latency",
        target: "resource:checkout-api",
        durationMs: 120000,
        lane: "lane-chaos-checkout",
      },
    ]);
    assert.equal(result.events[2].data.blastRadius.maxResources, 1);
    assert.equal(result.events.at(-1).data.reason, "steady-state-breached");
  });

  it("turns a failed experiment into a replayable regression test", async () => {
    const result = await orchestrateChaosExperiment({
      experiment: checkoutLatencyExperiment(),
      policyBudget: allowProdChaosBudget(),
      lane: signedLane(),
      now: sequentialClock("2026-06-27T20:10:00.000Z"),
      injector: recordingFaultInjector(),
      steadyStateCheck: () => ({
        status: "breached",
        invariant: "checkout-p95-under-250ms",
        observed: 900,
      }),
    });

    const replayed = replayChaosExperiment(result.events);

    assert.equal(replayed.status, "aborted");
    assert.deepEqual(replayed.regressionTests, [
      {
        id: "regression-chaos-checkout-latency",
        experimentId: "chaos-checkout-latency",
        sourceEventId: "chaos-aborted-chaos-checkout-latency",
        replayCommand: "hobo test --replay chaos-checkout-latency",
      },
    ]);
  });

  it("denies prod chaos without a policy budget before any fault is injected", async () => {
    const injector = recordingFaultInjector();
    const result = await orchestrateChaosExperiment({
      experiment: checkoutLatencyExperiment(),
      policyBudget: null,
      lane: signedLane(),
      now: sequentialClock("2026-06-27T20:20:00.000Z"),
      injector,
      steadyStateCheck: () => ({ status: "healthy", invariant: "checkout-p95-under-250ms" }),
    });

    assert.equal(result.status, "denied");
    assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided"]);
    assert.equal(result.events[0].data.effect, "deny");
    assert.equal(result.events[0].data.reason, "missing-prod-chaos-policy-budget");
    assert.deepEqual(injector.commands, []);
  });

  it("routes baseline-lease experiments to an ephemeral Camp clone instead of a shared lane", async () => {
    const result = await orchestrateChaosExperiment({
      experiment: checkoutLatencyExperiment({
        declaredSeams: [{ kind: "baseline-lease", resource: "actor:checkout-order" }],
      }),
      policyBudget: allowProdChaosBudget(),
      lane: signedLane(),
      now: sequentialClock("2026-06-27T20:30:00.000Z"),
      injector: recordingFaultInjector(),
      steadyStateCheck: () => ({ status: "healthy", invariant: "checkout-p95-under-250ms" }),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.executionTarget.kind, "ephemeral-camp-clone");
    assert.equal(result.events[1].type, "env.Cloned");
    assert.equal(result.events[2].data.executionTarget.kind, "ephemeral-camp-clone");
    assert.ok(!result.events.some((event) => event.type === "lane.Admitted"));
  });

  it("hard-stops when the abort condition itself fails", async () => {
    const injector = recordingFaultInjector();
    const result = await orchestrateChaosExperiment({
      experiment: checkoutLatencyExperiment(),
      policyBudget: allowProdChaosBudget(),
      lane: signedLane(),
      now: sequentialClock("2026-06-27T20:40:00.000Z"),
      injector,
      steadyStateCheck: () => {
        throw new Error("slo query unavailable");
      },
    });

    assert.equal(result.status, "aborted");
    assert.equal(result.events.at(-1).type, CHAOS_EVENT_TYPES.aborted);
    assert.equal(result.events.at(-1).data.reason, "abort-condition-failed");
    assert.equal(result.events.at(-1).data.error, "slo query unavailable");
    assert.equal(injector.commands.length, 1);
  });
});

function checkoutLatencyExperiment(overrides = {}) {
  return {
    id: "chaos-checkout-latency",
    hypothesis: {
      invariant: "checkout-p95-under-250ms",
      description: "checkout API remains inside latency SLO during edge delay",
    },
    fault: {
      kind: "latency",
      target: "resource:checkout-api",
      durationMs: 120000,
    },
    blastRadius: {
      tenant: "tenant-a",
      camp: "prod-us",
      environment: "prod",
      maxResources: 1,
      resources: ["resource:checkout-api"],
    },
    abortCondition: {
      invariant: "checkout-p95-under-250ms",
      threshold: 250,
    },
    declaredSeams: [],
    ...overrides,
  };
}

function allowProdChaosBudget() {
  return {
    id: "budget-prod-chaos",
    environments: ["prod"],
    remainingFaults: 1,
    maxBlastRadius: {
      tenant: "tenant-a",
      camp: "prod-us",
      maxResources: 1,
    },
  };
}

function signedLane() {
  return {
    id: "lane-chaos-checkout",
    tenant: "tenant-a",
    signed: true,
  };
}

function recordingFaultInjector() {
  return {
    commands: [],
    async inject(command) {
      this.commands.push(command);
      return { status: "injected", commandId: `fault-${this.commands.length}` };
    },
  };
}

function sequentialClock(startIso) {
  const start = Date.parse(startIso);
  let tick = 0;
  return () => new Date(start + tick++ * 60_000).toISOString();
}
