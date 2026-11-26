import { isJsonString, isJsonObject } from "./json.js";
import assert from "node:assert/strict";
import {

  createDeliveryAdapter,
  exportToCDEvent,
  importFromCDEvent,
  replayRollout,
  validateRolloutEvent,
} from "../../hobo-delivery-port/src/delivery-contract.js";
import {
  assign,
  conclude,
  createExperimentEvent,
  recordExposure,
} from "../../hobo-experiment-port/src/experiment-contract.js";

export function createBuiltInDeliveryAdapter() {
  return createDeliveryAdapter({
    supportedCapabilities: ["canary", "blue-green", "automated-rollback"],
  });
}

export function createFlaggerDeliveryAdapter() {
  return createDeliveryAdapter({
    supportedCapabilities: ["canary", "blue-green", "automated-rollback"],
  });
}

export function createMinimalDeliveryAdapter() {
  return createDeliveryAdapter({
    supportedCapabilities: ["canary"],
  });
}

export function createNonConformantCDEventsDeliveryAdapter() {
  return corruptEvents(createBuiltInDeliveryAdapter(), (event) => ({
    ...event,
    source: "flagger:self-report",
  }));
}

export function createRollbackDroppingDeliveryAdapter() {
  const adapter = createBuiltInDeliveryAdapter();
  return {
    ...adapter,
    rollback(command) {
      const before = adapter.status(command.rolloutId);
      return {
        status: before,
        events: [],
      };
    },
  };
}

export function createBuiltInExperimentAdapter() {
  return createExperimentAdapter();
}

export function createGrowthBookExperimentAdapter() {
  return createExperimentAdapter();
}

export function createRebucketingExperimentAdapter() {
  const adapter = createExperimentAdapter();
  let callCount = 0;
  return {
    ...adapter,
    assign(definition, request) {
      callCount += 1;
      const assignment = assign(definition, request);
      if (callCount === 1) {
        return assignment;
      }
      const nextVariant =
        assignment.variantKey === definition.variants[0].key
          ? definition.variants[1]
          : definition.variants[0];
      return {
        ...assignment,
        variantKey: nextVariant.key,
        flagVariant: nextVariant.flagVariant,
      };
    },
  };
}

export function runDeliveryAdapterConformance({ adapterName, createAdapter }) {
  const adapter = createAdapter();
  const checks = [];

  const promotedEvents = [
    ...adapter.start(deliveryRequest("delivery-promote")).events,
    ...adapter.step({ rolloutId: "delivery-promote", step: "ten-percent" }).events,
    ...adapter.promote({ rolloutId: "delivery-promote" }).events,
  ];
  assertEventTypes(promotedEvents, [
    "rollout.Started",
    "rollout.Stepped",
    "rollout.Promoted",
  ]);
  assert.deepEqual(replayRollout(promotedEvents), adapter.status("delivery-promote"));
  checks.push(check("rollout-started-stepped-promoted"));

  const rollbackEvents = [
    ...adapter.start(deliveryRequest("delivery-rollback")).events,
    ...adapter.step({ rolloutId: "delivery-rollback", step: "ten-percent" }).events,
    ...adapter.rollback({ rolloutId: "delivery-rollback", reason: "gate verdict rollback" }).events,
  ];
  assertEventTypes(rollbackEvents.slice(0, 2), ["rollout.Started", "rollout.Stepped"]);
  if (!rollbackEvents.some((event) => event.type === "rollout.RolledBack")) {
    throw new Error(`${adapterName} rollback verdict was not emitted`);
  }
  if (adapter.status("delivery-rollback").state !== "rolled-back") {
    throw new Error(`${adapterName} rollback verdict did not update adapter status`);
  }
  checks.push(check("rollout-rollback-verdict-honored"));

  for (const event of [...promotedEvents, ...rollbackEvents]) {
    assert.deepEqual(importFromCDEvent(exportToCDEvent(event)), validateRolloutEvent(event));
  }
  checks.push(check("rollout-cdevents-roundtrip"));

  return deepFreeze({
    adapterName,
    status: "passed",
    checks,
  });
}

export function runDeliveryCapabilityDegradationCheck({ adapterName, createAdapter }) {
  const started = createAdapter().start({
    ...deliveryRequest("delivery-degraded"),
    policy: {
      strategy: "blue-green",
      steps: [{ name: "flip", weight: 100, gateRefs: [] }],
      analysisWindow: { durationSeconds: 60, minSamples: 1 },
      requiredCapabilities: ["blue-green", "automated-rollback"],
    },
  });

  assert.equal(started.status.state, "running");
  assert.equal(started.status.warnings.length, 2);
  assert.deepEqual(started.events[0].data.warnings, started.status.warnings);

  return deepFreeze({
    adapterName,
    status: "passed",
    warnings: started.status.warnings,
  });
}

export function runExperimentAdapterConformance({ adapterName, createAdapter }) {
  const adapter = createAdapter();
  const definition = experimentDefinition();
  const request = {
    experimentKey: "checkout-copy",
    subject: subject("user_123"),
    contextHash: "tenant_a:user_123:checkout-copy",
  };
  const checks = [];

  const firstAssignment = adapter.assign(definition, request);
  const secondAssignment = adapter.assign(definition, request);
  if (firstAssignment.variantKey !== secondAssignment.variantKey) {
    throw new Error(`sticky assignment changed for subject ${request.subject.id}`);
  }
  assert.deepEqual(firstAssignment, secondAssignment);
  checks.push(check("deterministic-assignment"));

  const firstExposure = adapter.recordExposure(firstAssignment, {
    occurredAt: "2026-06-28T19:00:00.000Z",
  });
  const secondExposure = adapter.recordExposure(firstAssignment, {
    occurredAt: "2026-06-28T19:00:00.000Z",
  });
  assert.deepEqual(firstExposure, secondExposure);
  assert.equal(firstExposure.event.type, "experiment.Exposed");
  checks.push(check("idempotent-exposure"));

  const conclusion = adapter.conclude(definition, {
    verdict: "promote",
    winningVariant: firstAssignment.variantKey,
    confidence: 0.98,
    reason: "primary metric won and guardrails held",
  });
  assert.equal(conclusion.event.type, "experiment.Concluded");
  assert.equal(conclusion.conclusion.verdict, "promote");
  checks.push(check("concluded-verdict"));

  return deepFreeze({
    adapterName,
    status: "passed",
    checks,
  });
}

export function selectHarnessAdapters({
  camp,
  appCodeDigest,
  deliveryAdapter,
  experimentAdapter,
}) {
  assertNonEmptyString(camp, "camp");
  assertNonEmptyString(appCodeDigest, "appCodeDigest");
  assertNonEmptyString(deliveryAdapter, "deliveryAdapter");
  assertNonEmptyString(experimentAdapter, "experimentAdapter");

  return deepFreeze({
    camp,
    appCodeDigest,
    matching: {
      deliveryAdapter: {
        port: "hobo:delivery",
        adapter: deliveryAdapter,
        source: "camp-matching",
      },
      experimentAdapter: {
        port: "hobo:experiment",
        adapter: experimentAdapter,
        source: "camp-matching",
      },
    },
  });
}

function createExperimentAdapter() {
  const assignments = new Map();
  const exposures = new Map();

  return {
    assign(definition, request) {
      const key = assignmentKey(definition, request.subject);
      if (!assignments.has(key)) {
        assignments.set(key, assign(definition, request));
      }
      return clone(assignments.get(key));
    },

    recordExposure(assignment, input = {}) {
      const exposure = recordExposure(assignment, input);
      const key = `${assignmentKey({ key: assignment.experimentKey }, assignment.subject)}:${assignment.variantKey}`;
      if (!exposures.has(key)) {
        exposures.set(key, {
          exposure,
          event: createExperimentEvent("experiment.Exposed", exposure),
        });
      }
      return clone(exposures.get(key));
    },

    conclude(definition, input = {}) {
      const conclusion = conclude(definition, input);
      return {
        conclusion,
        event: createExperimentEvent("experiment.Concluded", conclusion),
      };
    },
  };
}

function corruptEvents(adapter, corrupt) {
  const wrap = (method) => (command) => {
    const result = adapter[method](command);
    return {
      ...result,
      events: result.events.map(corrupt),
    };
  };

  return {
    ...adapter,
    start: wrap("start"),
    step: wrap("step"),
    promote: wrap("promote"),
    rollback: wrap("rollback"),
    abort: wrap("abort"),
  };
}

function deliveryRequest(rolloutId) {
  return {
    rolloutId,
    runId: `run-${rolloutId}`,
    tenant: "tenant_a",
    target: {
      service: "checkout-web",
      fromVersion: "checkout@sha256:old",
      toVersion: "checkout@sha256:new",
    },
    policy: {
      strategy: "canary",
      steps: [{ name: "ten-percent", weight: 10, gateRefs: [{ kind: "slo", id: "checkout-red" }] }],
      analysisWindow: { durationSeconds: 300, minSamples: 100 },
      requiredCapabilities: ["canary", "automated-rollback"],
    },
  };
}

function experimentDefinition() {
  return {
    key: "checkout-copy",
    flagKey: "checkout-variant",
    sampleRatioBasisPoints: 10000,
    variants: [
      { key: "control", allocationBasisPoints: 5000, flagVariant: "control" },
      { key: "treatment", allocationBasisPoints: 5000, flagVariant: "short-copy" },
    ],
    metrics: [
      {
        name: "checkout.completed",
        kind: "counter",
        source: "otel://meter/checkout",
        primary: true,
      },
    ],
  };
}

function subject(id) {
  return {
    kind: "user",
    id,
    tenant: "tenant_a",
  };
}

function assignmentKey(definition, assignmentSubject) {
  return `${definition.key}:${assignmentSubject.tenant}:${assignmentSubject.kind}:${assignmentSubject.id}`;
}

function assertEventTypes(events, expectedTypes) {
  for (const event of events) {
    validateRolloutEvent(event);
  }
  assert.deepEqual(events.map((event) => event.type), expectedTypes);
}

function check(name) {
  return {
    name,
    status: "passed",
  };
}

function assertNonEmptyString(value, label) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
