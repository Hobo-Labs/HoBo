import assert from "node:assert/strict";
import { test } from "vitest";

import { evaluateRunawaySpendCircuitBreaker } from "../../runaway-spend-circuit-breaker-contract/src/runaway-spend-circuit-breaker.js";

import {
  COST_DEGRADATION_SAGA_ENGINE_ID,
  evaluateCostDegradationSaga,
} from "../src/cost-degradation-saga.js";

const NOW = "2026-06-28T12:00:00.000Z";

function requirement(overrides = {}) {
  return {
    type: "spend.DegradationRequired",
    id: "spend.DegradationRequired:reduced",
    policyId: "cost-availability:camp-prod/monthly",
    profileId: "cost-availability-profile:camp-prod",
    scopeKind: "camp",
    scopeId: "tenant-a/camp-prod",
    tier: "reduced",
    durable: true,
    strategy: "shed-low-priority-first",
    shed: ["request-priority", "feature-flag:analytics", "canary-hold"],
    spendVelocityUsdPerHour: 28,
    projectedPeriodSpendUsd: 83,
    thresholdUsd: 80,
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: "cost-availability-profile:camp-prod",
    scope: { kind: "camp", id: "tenant-a/camp-prod" },
    budgetUsd: 100,
    availabilitySlo: 0.995,
    tiers: [
      {
        name: "nominal",
        budgetFraction: 0.5,
        availabilitySlo: 0.999,
        strategy: "observe",
        shed: [],
      },
      {
        name: "reduced",
        budgetFraction: 0.8,
        availabilitySlo: 0.995,
        strategy: "shed-low-priority-first",
        shed: ["request-priority", "feature-flag:analytics", "canary-hold"],
        retryAfterSeconds: 45,
      },
      {
        name: "minimal",
        budgetFraction: 0.95,
        availabilitySlo: 0.99,
        strategy: "fail-closed",
        shed: ["request-priority", "scale-to-zero:analytics-worker"],
      },
    ],
    recoveryHysteresisSeconds: 300,
    ...overrides,
  };
}

function resources(overrides = {}) {
  return [
    {
      id: "checkout-api",
      priority: "critical",
      dependencies: [],
      levers: ["canary-hold", "cache-ttl"],
    },
    {
      id: "analytics-worker",
      priority: "low",
      dependencies: [],
      levers: ["scale-to-zero", "feature-flag"],
    },
    {
      id: "recommendations",
      priority: "standard",
      dependencies: ["checkout-api"],
      levers: ["request-priority", "cache-ttl"],
    },
    ...(overrides.extra ?? []),
  ];
}

function runtime(overrides = {}) {
  return {
    observedAvailability: 0.997,
    projectedAvailabilityAfterActions: 0.996,
    lowPriorityQueueDepth: 30,
    retryAfterConsumerBudgetPerMinute: 120,
    belowTierThresholdSince: null,
    spendVelocityUsdPerHour: 28,
    ...overrides,
  };
}

test("crossing reduced tier sheds low-priority load with honest Retry-After and keeps SLO floor", () => {
  const result = evaluateCostDegradationSaga({
    requirement: requirement(),
    profile: profile(),
    resources: resources(),
    runtime: runtime(),
    now: NOW,
  });

  assert.equal(result.engine, COST_DEGRADATION_SAGA_ENGINE_ID);
  assert.equal(result.decision.effect, "apply-degradation");
  assert.equal(result.decision.tier, "reduced");
  assert.equal(result.decision.availabilityFloorHeld, true);
  assert.equal(result.breakerHandoff.degradationExhausted, false);
  assert.deepEqual(
    result.steps.map((step) => [step.lever, step.targetId, step.priority]),
    [
      ["request-priority", "recommendations", "standard"],
      ["feature-flag", "analytics", "low"],
      ["canary-hold", "checkout-api", "critical"],
    ],
  );

  const requestShed = result.steps.find((step) => step.lever === "request-priority");
  assert.equal(requestShed.response.status, 503);
  assert.equal(requestShed.response.headers["Retry-After"], "45");
  assert.equal(requestShed.response.silentHang, false);
  assert.equal(requestShed.response.maxRejectedPerMinute, 120);
  assert.ok(result.events.every((event) => event.type === "spend.DegradationApplied"));
});

test("degrade-all tiers can apply cache TTL without destructive critical shedding", () => {
  const result = evaluateCostDegradationSaga({
    requirement: requirement({
      tier: "brownout",
      shed: ["cache-ttl:checkout-api", "request-priority"],
    }),
    profile: profile({
      tiers: [
        ...profile().tiers,
        {
          name: "brownout",
          budgetFraction: 0.9,
          availabilitySlo: 0.992,
          strategy: "degrade-all",
          shed: ["cache-ttl:checkout-api", "request-priority"],
          cacheTtlSeconds: 120,
        },
      ],
    }),
    resources: resources({
      extra: [
        {
          id: "catalog-api",
          priority: "low",
          dependencies: [],
          levers: ["request-priority"],
        },
      ],
    }),
    runtime: runtime({ projectedAvailabilityAfterActions: 0.993 }),
    now: NOW,
  });

  assert.equal(result.decision.effect, "apply-degradation");
  assert.deepEqual(
    result.steps.map((step) => [step.lever, step.targetId, step.action]),
    [
      ["cache-ttl", "checkout-api", "increase-cache-ttl"],
      ["request-priority", "catalog-api", "shed-low-priority-calls"],
    ],
  );
  assert.equal(result.steps[0].ttlSeconds, 120);
  assert.equal(result.events[0].step, "cache-ttl");
});

test("recovery rolls back only after hysteresis clears tier boundary", () => {
  const activeEvents = [
    {
      type: "spend.DegradationApplied",
      id: "applied:request-priority",
      profileId: "cost-availability-profile:camp-prod",
      scopeKind: "camp",
      scopeId: "tenant-a/camp-prod",
      tier: "reduced",
      step: "request-priority",
      targetId: "recommendations",
      occurredAt: "2026-06-28T11:50:00.000Z",
    },
  ];

  const flapping = evaluateCostDegradationSaga({
    requirement: requirement({ projectedPeriodSpendUsd: 70 }),
    profile: profile(),
    resources: resources(),
    runtime: runtime({
      spendVelocityUsdPerHour: 4,
      belowTierThresholdSince: "2026-06-28T11:57:00.000Z",
      projectedAvailabilityAfterActions: 0.998,
    }),
    priorEvents: activeEvents,
    now: NOW,
  });
  const recovered = evaluateCostDegradationSaga({
    requirement: requirement({ projectedPeriodSpendUsd: 70 }),
    profile: profile(),
    resources: resources(),
    runtime: runtime({
      spendVelocityUsdPerHour: 4,
      belowTierThresholdSince: "2026-06-28T11:54:00.000Z",
      projectedAvailabilityAfterActions: 0.998,
    }),
    priorEvents: activeEvents,
    now: NOW,
  });

  assert.equal(flapping.decision.effect, "hold-degradation");
  assert.equal(flapping.events.length, 0);
  assert.equal(flapping.decision.reason, "recovery hysteresis has not elapsed");

  assert.equal(recovered.decision.effect, "rollback-degradation");
  assert.equal(recovered.events[0].type, "spend.DegradationRolledBack");
  assert.equal(recovered.events[0].fromTier, "reduced");
  assert.equal(recovered.events[0].toTier, "nominal");
});

test("breaker only trips after graceful tiers are exhausted", () => {
  const degraded = evaluateCostDegradationSaga({
    requirement: requirement(),
    profile: profile(),
    resources: resources(),
    runtime: runtime(),
    now: NOW,
  });
  const exhausted = evaluateCostDegradationSaga({
    requirement: requirement({ tier: "minimal", strategy: "fail-closed" }),
    profile: profile(),
    resources: [{ id: "checkout-api", priority: "critical", dependencies: [], levers: [] }],
    runtime: runtime(),
    now: NOW,
  });

  const breakerPolicy = {
    id: "spend-breaker:camp-prod",
    scope: { kind: "camp", id: "tenant-a/camp-prod" },
    velocityThresholdUsdPerHour: 20,
    debounce: {
      minSamples: 3,
      minDurationSeconds: 120,
      windowSeconds: 300,
      maxSampleAgeSeconds: 300,
    },
    requireDegradationExhausted: true,
  };
  const meteringView = {
    view: "MeteringView",
    seq: 50,
    digest: "metering-digest-50",
    currency: "USD",
  };
  const samples = [0, 1, 2].map((index) => ({
    id: `sample-${index}`,
    seq: 50 + index,
    observedAt: new Date(Date.parse(NOW) - (120 - index * 60) * 1000).toISOString(),
    spendVelocityUsdPerHour: 32,
    degradationExhausted: degraded.breakerHandoff.degradationExhausted,
  }));
  const exhaustedSamples = samples.map((sample) => ({
    ...sample,
    degradationExhausted: exhausted.breakerHandoff.degradationExhausted,
  }));

  const beforeExhaustion = evaluateRunawaySpendCircuitBreaker({
    policy: breakerPolicy,
    meteringView,
    samples,
    action: { id: "action:deploy", kind: "hobo:deployment:apply" },
    now: NOW,
  });
  const afterExhaustion = evaluateRunawaySpendCircuitBreaker({
    policy: breakerPolicy,
    meteringView,
    samples: exhaustedSamples,
    action: { id: "action:deploy", kind: "hobo:deployment:apply" },
    now: NOW,
  });

  assert.equal(beforeExhaustion.state.status, "closed");
  assert.equal(afterExhaustion.state.status, "open");
  assert.equal(afterExhaustion.events[0].lastResort, true);
});

test("fail-closed tier and critical-only load escalate without silent shedding", () => {
  const result = evaluateCostDegradationSaga({
    requirement: requirement({
      tier: "minimal",
      strategy: "fail-closed",
      shed: ["request-priority", "scale-to-zero:checkout-api"],
    }),
    profile: profile(),
    resources: [{ id: "checkout-api", priority: "critical", dependencies: [], levers: ["request-priority"] }],
    runtime: runtime(),
    now: NOW,
  });

  assert.equal(result.decision.effect, "escalate-to-breaker");
  assert.equal(result.breakerHandoff.degradationExhausted, true);
  assert.equal(result.steps.length, 0);
  assert.equal(result.events[0].type, "spend.DegradationApplied");
  assert.equal(result.events[0].step, "fail-closed");
  assert.equal(result.events[0].reason, "no non-critical load can be shed");
});

test("unsafe tier plans fail closed for critical dependencies, retry storms, and SLO floor violations", () => {
  const criticalDependency = evaluateCostDegradationSaga({
    requirement: requirement({
      shed: ["scale-to-zero:checkout-api"],
    }),
    profile: profile(),
    resources: resources(),
    runtime: runtime(),
    now: NOW,
  });
  const retryStorm = evaluateCostDegradationSaga({
    requirement: requirement(),
    profile: profile(),
    resources: resources(),
    runtime: runtime({ retryAfterConsumerBudgetPerMinute: 0 }),
    now: NOW,
  });
  const sloViolation = evaluateCostDegradationSaga({
    requirement: requirement(),
    profile: profile(),
    resources: resources(),
    runtime: runtime({ projectedAvailabilityAfterActions: 0.99 }),
    now: NOW,
  });

  assert.equal(criticalDependency.decision.effect, "fail-closed");
  assert.match(criticalDependency.decision.reason, /critical/);
  assert.equal(criticalDependency.events[0].reason, "critical resource would be shed");

  assert.equal(retryStorm.decision.effect, "fail-closed");
  assert.match(retryStorm.decision.reason, /Retry-After storm/);

  assert.equal(sloViolation.decision.effect, "fail-closed");
  assert.match(sloViolation.decision.reason, /availabilitySlo/);
});
