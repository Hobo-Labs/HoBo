import assert from "node:assert/strict";
import { test } from "vitest";

import { createGoldenSlo, parseSloDefinition, validateSloEvent } from "../../slo-as-code-contract/src/slo-contract.js";
import {
  SLO_COMPUTATION_ENGINE_VERSION,
  computeSloStatus,
  createBuiltInSloDefinitions,
  createFixtureSliSource,
  makeBudgetBurnedEvent,
} from "../src/slo-computation-engine.js";

const NOW = "2026-06-26T04:00:00.000Z";

test("fixture SLI breaching objective computes remaining budget and burn rate", () => {
  const definition = makeDefinition();
  const source = createFixtureSliSource([
    sample("2026-06-26T03:59:00.000Z", 9850, 10000),
  ]);

  const status = computeSloStatus({ definition, sliSource: source, now: NOW });

  assert.equal(status.schema, SLO_COMPUTATION_ENGINE_VERSION);
  assert.equal(status.status, "budget-exhausted");
  assert.equal(status.objectiveWindow.good, 9850);
  assert.equal(status.objectiveWindow.total, 10000);
  assert.equal(status.objectiveWindow.errorBudget, 100);
  assert.equal(status.objectiveWindow.errors, 150);
  assert.equal(status.objectiveWindow.burnRate, 1.5);
  assert.equal(status.objectiveWindow.remainingBudgetRatio, 0);
});

test("multi-window burn-rate fires fast for severe burn and slow for gradual burn", () => {
  const definition = makeDefinition();
  const severe = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource([
      ...minuteSamples("2026-06-26T03:55:00.000Z", 55, 1000, 1000),
      ...minuteSamples("2026-06-26T04:00:00.000Z", 5, 800, 1000),
    ]),
    now: NOW,
  });

  assert.deepEqual(severe.violatedThresholds.map((threshold) => threshold.name), ["fast-burn"]);
  assert.equal(windowByName(severe, "fast-burn").burnRate, 20);
  assert.equal(windowByName(severe, "slow-burn").burnRate, 1.667);

  const gradual = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource(minuteSamples("2026-06-26T04:00:00.000Z", 60, 980, 1000)),
    now: NOW,
  });

  assert.deepEqual(gradual.violatedThresholds.map((threshold) => threshold.name), ["slow-burn"]);
  assert.equal(windowByName(gradual, "fast-burn").burnRate, 2);
  assert.equal(windowByName(gradual, "slow-burn").burnRate, 2);
});

test("slo.BudgetBurned event carries computed burn rate and remaining budget magnitude", () => {
  const definition = makeDefinition();
  const status = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource(minuteSamples("2026-06-26T04:00:00.000Z", 60, 980, 1000)),
    now: NOW,
  });

  const event = makeBudgetBurnedEvent(status, {
    id: "evt-hobo-277",
    seq: 277,
    time: NOW,
  });
  const parsed = validateSloEvent(event);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.equal(event.type, "slo.BudgetBurned");
  assert.equal(event.data.sloName, "checkout-availability");
  assert.equal(event.data.window, "slow-burn");
  assert.equal(event.data.burnRate, 2);
  assert.equal(event.data.remainingBudgetRatio, 0);
});

test("healthy SLI does not burn budget or emit a BudgetBurned event", () => {
  const definition = makeDefinition();
  const status = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource(minuteSamples("2026-06-26T04:00:00.000Z", 60, 1000, 1000)),
    now: NOW,
  });

  assert.equal(status.status, "healthy");
  assert.equal(status.objectiveWindow.remainingBudgetRatio, 1);
  assert.deepEqual(status.violatedThresholds, []);
  assert.equal(makeBudgetBurnedEvent(status, { id: "evt-healthy", seq: 1, time: NOW }), null);
});

test("gap in SLI series fails closed instead of treating no data as 100 percent healthy", () => {
  const definition = makeDefinition();
  const status = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource([]),
    now: NOW,
  });

  assert.equal(status.status, "no-data");
  assert.equal(status.healthy, false);
  assert.equal(status.objectiveWindow.total, 0);
  assert.equal(status.objectiveWindow.remainingBudgetRatio, 0);
});

test("burst can burn the whole budget inside one fast window", () => {
  const definition = makeDefinition();
  const status = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource([
      sample("2026-06-26T03:59:00.000Z", 8000, 10000),
    ]),
    now: NOW,
  });

  assert.equal(status.status, "budget-exhausted");
  assert.equal(status.objectiveWindow.remainingBudgetRatio, 0);
  assert.equal(windowByName(status, "fast-burn").burnRate, 20);
});

test("window boundaries are half-open to avoid double counting adjacent windows", () => {
  const definition = makeDefinition();
  const status = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource([
      sample("2026-06-26T03:55:00.000Z", 0, 1000),
      sample("2026-06-26T04:00:00.000Z", 1000, 1000),
    ]),
    now: NOW,
  });

  const fast = windowByName(status, "fast-burn");

  assert.equal(fast.total, 1000);
  assert.equal(fast.good, 1000);
  assert.equal(fast.burnRate, 0);
});

test("stale SLI source values fail closed with a freshness reason", () => {
  const definition = makeDefinition();
  const status = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource([
      sample("2026-06-26T03:57:00.000Z", 1000, 1000),
    ]),
    maxStaleness: "2m",
    now: NOW,
  });

  assert.equal(status.status, "stale");
  assert.equal(status.healthy, false);
  assert.equal(status.reason, "latest-sli-sample-older-than-2m");
});

test("zero traffic fails closed without dividing by zero", () => {
  const definition = makeDefinition();
  const status = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource([
      sample("2026-06-26T03:59:00.000Z", 0, 0),
    ]),
    now: NOW,
  });

  assert.equal(status.status, "invalid-sli-zero-total");
  assert.equal(status.healthy, false);
  assert.equal(status.objectiveWindow.burnRate, null);
});

test("built-in deploy success and control-plane availability SLOs are valid SLO-as-code definitions", () => {
  const builtIns = createBuiltInSloDefinitions();

  assert.deepEqual(builtIns.map((definition) => definition.metadata.name), [
    "deploy-success-rate",
    "control-plane-availability",
  ]);
  for (const definition of builtIns) {
    const parsed = parseSloDefinition(definition);
    assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  }
});

function makeDefinition() {
  return createGoldenSlo({
    spec: {
      timeWindow: {
        duration: "1h",
        isRolling: true,
      },
      burnRateThresholds: [
        {
          name: "fast-burn",
          threshold: 14.4,
          lookbackWindow: "5m",
          samplingInterval: "1m",
        },
        {
          name: "slow-burn",
          threshold: 2,
          lookbackWindow: "1h",
          samplingInterval: "5m",
        },
      ],
    },
  });
}

function sample(time, good, total) {
  return { time, good, total };
}

function minuteSamples(lastIso, count, good, total) {
  const last = Date.parse(lastIso);
  return Array.from({ length: count }, (_, index) => ({
    time: new Date(last - (count - index - 1) * 60_000).toISOString(),
    good,
    total,
  }));
}

function windowByName(status, name) {
  const window = status.burnRateWindows.find((candidate) => candidate.name === name);
  assert.ok(window, `missing window ${name}`);
  return window;
}
