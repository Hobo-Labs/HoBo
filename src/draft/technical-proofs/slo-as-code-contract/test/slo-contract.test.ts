import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  SLO_EVENT_TYPES,
  applyBudgetEvent,
  createGoldenSlo,
  deserializeSloDefinition,
  deserializeSloEvent,
  hashSloDefinition,
  initialBudgetView,
  makeSloEvent,
  parseSloDefinition,
  replayBudgetView,
  resolveOverlappingSloConflicts,
  serializeSloDefinition,
  serializeSloEvent,
  validateSloEvent,
} from "../src/slo-contract.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("schema validates the golden SLO fixture and publishes the contract surface", async () => {
  const schema = JSON.parse(
    await readFile(path.join(packageRoot, "schema", "hobo.slo.v1.schema.json"), "utf8"),
  );
  const typeDeclarations = await readFile(path.join(packageRoot, "src", "slo-contract.d.ts"), "utf8");
  const wit = await readFile(path.join(packageRoot, "wit", "world.wit"), "utf8");
  const slo = createGoldenSlo();
  const parsed = parseSloDefinition(slo);

  assert.equal(schema.$id, "https://schemas.hobo.dev/hobo.slo.v1.schema.json");
  assert.equal(schema.properties.apiVersion.const, "openslo/v1");
  assert.match(typeDeclarations, /export interface SloDefinition/);
  assert.match(wit, /package hobo:slo@0.1.0/);
  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.deepEqual(deserializeSloDefinition(serializeSloDefinition(slo)).slo, parsed.slo);
});

test("SLO definitions reject missing windows and missing SLI sources", () => {
  const noWindow = createGoldenSlo();
  delete noWindow.spec.timeWindow;

  const noSliSource = createGoldenSlo();
  delete noSliSource.spec.indicator;

  assert.equal(parseSloDefinition(noWindow).ok, false);
  assert.match(parseSloDefinition(noWindow).errors.join("\n"), /spec\.timeWindow must be an object/);
  assert.equal(parseSloDefinition(noSliSource).ok, false);
  assert.match(parseSloDefinition(noSliSource).errors.join("\n"), /spec\.indicator must define an SLI source/);
});

test("slo events validate against the telemetry envelope and round-trip", () => {
  const slo = createGoldenSlo();
  const declared = makeSloEvent({
    id: "evt-1",
    type: "slo.Declared",
    sloName: slo.metadata.name,
    seq: 1,
    data: {
      definitionHash: hashSloDefinition(slo),
    },
  });
  const burned = makeSloEvent({
    id: "evt-2",
    type: "slo.BudgetBurned",
    sloName: slo.metadata.name,
    seq: 2,
    data: {
      window: "30d",
      good: 995,
      total: 1000,
      burnRate: 2,
      remainingBudgetRatio: 0.5,
    },
  });
  const exhausted = makeSloEvent({
    id: "evt-3",
    type: "slo.BudgetExhausted",
    sloName: slo.metadata.name,
    seq: 3,
    data: {
      remainingBudgetRatio: 0,
    },
  });

  for (const event of [declared, burned, exhausted]) {
    const parsed = validateSloEvent(event);
    assert.equal(parsed.ok, true, parsed.errors.join("\n"));
    assert.deepEqual(deserializeSloEvent(serializeSloEvent(event)).event, parsed.event);
  }

  const malformedEnvelope = structuredClone(burned);
  malformedEnvelope.meta.traceparent = "not-w3c";

  assert.equal(validateSloEvent(malformedEnvelope).ok, false);
  assert.match(validateSloEvent(malformedEnvelope).errors.join("\n"), /meta\.traceparent/);
  assert.deepEqual(SLO_EVENT_TYPES, ["slo.Declared", "slo.BudgetBurned", "slo.BudgetExhausted"]);
});

test("from-zero replay reconstructs the same remaining-budget view as live folding", () => {
  const slo = createGoldenSlo();
  const events = [
    makeSloEvent({
      id: "evt-2",
      type: "slo.BudgetBurned",
      sloName: slo.metadata.name,
      seq: 2,
      data: {
        window: "30d",
        good: 995,
        total: 1000,
        burnRate: 2,
        remainingBudgetRatio: 0.5,
      },
    }),
    makeSloEvent({
      id: "evt-3",
      type: "slo.BudgetBurned",
      sloName: slo.metadata.name,
      seq: 3,
      data: {
        window: "30d",
        good: 998,
        total: 1000,
        burnRate: 1.4,
        remainingBudgetRatio: 0.3,
      },
    }),
  ];

  const liveView = events.reduce(
    (view, event) => applyBudgetEvent(view, slo, event),
    initialBudgetView(slo),
  );

  assert.deepEqual(replayBudgetView(slo, events), liveView);
  assert.equal(liveView.consumedBudgetRatio, 0.7);
  assert.equal(liveView.remainingBudgetRatio, 0.3);
});

test("budget replay exhaustion follows the canonical rounded remaining budget", () => {
  const slo = createGoldenSlo();
  const event = makeSloEvent({
    id: "evt-rounding",
    type: "slo.BudgetBurned",
    sloName: slo.metadata.name,
    seq: 4,
    data: {
      window: "30d",
      good: 1000,
      total: 1000,
      burnRate: 0,
      remainingBudgetRatio: 0,
    },
  });

  const view = applyBudgetEvent(
    { ...initialBudgetView(slo), consumedBudgetRatio: 0.99999999999995 },
    slo,
    event,
  );

  assert.equal(view.remainingBudgetRatio, 0);
  assert.equal(view.exhausted, true);
});

test("good greater than total fails closed in budget events", () => {
  const event = makeSloEvent({
    id: "evt-bad",
    type: "slo.BudgetBurned",
    sloName: "checkout-availability",
    seq: 1,
    data: {
      window: "30d",
      good: 1001,
      total: 1000,
      burnRate: 1,
      remainingBudgetRatio: 0.9,
    },
  });

  const parsed = validateSloEvent(event);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /data\.good must be <= data\.total/);
});

test("a 100 percent objective is flagged as ungateable instead of silently freezing deploys", () => {
  const slo = createGoldenSlo();
  slo.spec.objectives[0].target = 1;
  const parsed = parseSloDefinition(slo);
  const view = initialBudgetView(slo);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.match(parsed.warnings.join("\n"), /no error budget and is ungateable/);
  assert.equal(view.gateable, false);
  assert.equal(view.reason, "objective-has-no-error-budget");
});

test("burn-rate windows shorter than their sampling interval are rejected", () => {
  const slo = createGoldenSlo();
  slo.spec.burnRateThresholds[0].lookbackWindow = "30s";
  slo.spec.burnRateThresholds[0].samplingInterval = "1m";

  const parsed = parseSloDefinition(slo);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /lookbackWindow must be >= samplingInterval/);
});

test("conflicting overlapping SLOs resolve deterministically", () => {
  const relaxed = createGoldenSlo({
    metadata: { name: "checkout-relaxed" },
    spec: { objectives: [{ displayName: "availability", target: 0.99 }] },
  });
  const strict = createGoldenSlo({
    metadata: { name: "checkout-strict" },
    spec: { objectives: [{ displayName: "availability", target: 0.999 }] },
  });

  assert.deepEqual(resolveOverlappingSloConflicts([relaxed, strict]), [
    {
      key: "checkout-api|{\n  \"good\": \"sum(rate(http_requests_total{code=~'2..|3..'}[5m]))\",\n  \"total\": \"sum(rate(http_requests_total[5m]))\"\n}",
      winner: "checkout-strict",
      candidates: ["checkout-relaxed", "checkout-strict"],
    },
  ]);
  assert.deepEqual(
    resolveOverlappingSloConflicts([strict, relaxed]),
    resolveOverlappingSloConflicts([relaxed, strict]),
  );
});
