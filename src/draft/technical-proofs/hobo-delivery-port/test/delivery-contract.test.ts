import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  createDeliveryAdapter,
  exportToCDEvent,
  importFromCDEvent,
  replayRollout,
  rolloutStarted,
  validateRolloutEvent,
} from "../src/delivery-contract.js";

const root = join(import.meta.dirname, "..");

test("WIT contract exposes hobo:delivery operations and generated bindings", async () => {
  const wit = await readFile(join(root, "wit", "world.wit"), "utf8");
  const providerBindings = await readFile(
    join(root, "generated", "interfaces", "hobo-delivery-provider.d.ts"),
    "utf8",
  );
  const typesBindings = await readFile(
    join(root, "generated", "interfaces", "hobo-delivery-types.d.ts"),
    "utf8",
  );

  for (const operation of ["start", "step", "promote", "rollback", "abort", "status"]) {
    assert.match(wit, new RegExp(`${operation}: func`));
    assert.match(providerBindings, new RegExp(`${operation}\\(`));
  }

  assert.match(typesBindings, /RolloutStarted/);
  assert.match(typesBindings, /RolloutStepped/);
  assert.match(typesBindings, /RolloutPromoted/);
  assert.match(typesBindings, /RolloutRolledBack/);
  assert.match(typesBindings, /RolloutFailed/);
});

test("rollout events validate against the event envelope schema", () => {
  const event = rolloutStarted({
    rolloutId: "rollout_123",
    runId: "run_123",
    tenant: "tenant_a",
    target: {
      service: "checkout-web",
      fromVersion: "checkout@sha256:old",
      toVersion: "checkout@sha256:new",
    },
    policy: {
      strategy: "canary",
      steps: [{ name: "five-percent", weight: 5, gateRefs: [{ kind: "slo", id: "checkout-red" }] }],
      analysisWindow: { durationSeconds: 300, minSamples: 100 },
      requiredCapabilities: ["canary", "automated-rollback"],
    },
  });

  assert.equal(validateRolloutEvent(event), event);
  assert.equal(event.type, "rollout.Started");
  assert.equal(event.specversion, "1.0");
  assert.equal(event.source, "hobo:delivery");
  assert.equal(event.subject, "rollout_123");

  assert.throws(
    () => validateRolloutEvent({ ...event, type: "rollout.Unknown" }),
    /unsupported rollout event/i,
  );
  assert.throws(
    () => validateRolloutEvent({ ...event, data: { ...event.data, policy: undefined } }),
    /rollout.Started data missing policy/i,
  );
});

test("no-op rollout drives Started to Stepped to Promoted and replays to the live view", () => {
  const adapter = createDeliveryAdapter({
    supportedCapabilities: ["canary", "automated-rollback"],
  });
  const request = {
    rolloutId: "rollout_200",
    runId: "run_200",
    tenant: "tenant_a",
    target: {
      service: "checkout-web",
      fromVersion: "checkout@sha256:old",
      toVersion: "checkout@sha256:new",
    },
    policy: {
      strategy: "canary",
      steps: [{ name: "full", weight: 100, gateRefs: [] }],
      analysisWindow: { durationSeconds: 1, minSamples: 0 },
      requiredCapabilities: ["canary"],
    },
  };

  const log = [
    ...adapter.start(request).events,
    ...adapter.step({ rolloutId: "rollout_200", step: "full" }).events,
    ...adapter.promote({ rolloutId: "rollout_200" }).events,
  ];

  assert.deepEqual(log.map((event) => event.type), [
    "rollout.Started",
    "rollout.Stepped",
    "rollout.Promoted",
  ]);
  assert.deepEqual(replayRollout(log), adapter.status("rollout_200"));
  assert.deepEqual(replayRollout(log), {
    rolloutId: "rollout_200",
    state: "promoted",
    currentStep: "full",
    warnings: [],
  });
});

test("CDEvents export of a rollout event round-trips to the internal shape", () => {
  const internal = rolloutStarted({
    rolloutId: "rollout_cdevents",
    runId: "run_cdevents",
    tenant: "tenant_a",
    target: {
      service: "checkout-web",
      fromVersion: "checkout@sha256:old",
      toVersion: "checkout@sha256:new",
    },
    policy: {
      strategy: "blue-green",
      steps: [{ name: "flip", weight: 100, gateRefs: [] }],
      analysisWindow: { durationSeconds: 60, minSamples: 1 },
      requiredCapabilities: ["blue-green"],
    },
  });

  const cdEvent = exportToCDEvent(internal);

  assert.equal(cdEvent.context.version, "0.4.1");
  assert.equal(cdEvent.subject.id, "rollout_cdevents");
  assert.equal(cdEvent.subject.type, "service");
  assert.equal(cdEvent.predicate.type, "started");
  assert.deepEqual(importFromCDEvent(cdEvent), internal);
});

test("rollback emits rollout.RolledBack and maps to a CDEvents predicate", () => {
  const adapter = createDeliveryAdapter({ supportedCapabilities: ["blue-green"] });
  adapter.start({
    rolloutId: "rollout_rollback",
    runId: "run_rollback",
    tenant: "tenant_a",
    target: {
      service: "checkout-web",
      fromVersion: "checkout@sha256:old",
      toVersion: "checkout@sha256:new",
    },
    policy: {
      strategy: "blue-green",
      steps: [{ name: "flip", weight: 100, gateRefs: [] }],
      analysisWindow: { durationSeconds: 60, minSamples: 1 },
      requiredCapabilities: ["blue-green"],
    },
  });

  const rolledBack = adapter.rollback({
    rolloutId: "rollout_rollback",
    reason: "gate failed after flip",
  });
  const cdEvent = exportToCDEvent(rolledBack.events[0]);

  assert.equal(rolledBack.status.state, "rolled-back");
  assert.equal(rolledBack.events[0].type, "rollout.RolledBack");
  assert.equal(rolledBack.events[0].data.restoredVersion, "checkout@sha256:old");
  assert.equal(cdEvent.predicate.type, "rolled-back");
  assert.deepEqual(importFromCDEvent(cdEvent), rolledBack.events[0]);
});

test("abort mid-step emits rollout.Failed instead of leaving a dangling rollout", () => {
  const adapter = createDeliveryAdapter({ supportedCapabilities: ["canary"] });
  adapter.start({
    rolloutId: "rollout_abort",
    runId: "run_abort",
    tenant: "tenant_a",
    target: {
      service: "checkout-web",
      fromVersion: "checkout@sha256:old",
      toVersion: "checkout@sha256:new",
    },
    policy: {
      strategy: "canary",
      steps: [{ name: "five-percent", weight: 5, gateRefs: [] }],
      analysisWindow: { durationSeconds: 300, minSamples: 100 },
      requiredCapabilities: ["canary"],
    },
  });
  adapter.step({ rolloutId: "rollout_abort", step: "five-percent" });

  const aborted = adapter.abort({ rolloutId: "rollout_abort", reason: "operator stopped canary" });

  assert.equal(aborted.status.state, "failed");
  assert.deepEqual(aborted.events.map((event) => event.type), ["rollout.Failed"]);
  assert.equal(aborted.events[0].data.reason, "operator stopped canary");
  assert.equal(aborted.events[0].data.dangling, false);
});

test("missing adapter capabilities degrade with PlanWarning and never panic", () => {
  const adapter = createDeliveryAdapter({ supportedCapabilities: ["canary"] });

  const started = adapter.start({
    rolloutId: "rollout_warn",
    runId: "run_warn",
    tenant: "tenant_a",
    target: {
      service: "checkout-web",
      fromVersion: "checkout@sha256:old",
      toVersion: "checkout@sha256:new",
    },
    policy: {
      strategy: "blue-green",
      steps: [{ name: "flip", weight: 100, gateRefs: [] }],
      analysisWindow: { durationSeconds: 60, minSamples: 1 },
      requiredCapabilities: ["blue-green", "automated-rollback"],
    },
  });

  assert.equal(started.status.state, "running");
  assert.deepEqual(started.status.warnings, [
    {
      code: "delivery.capability_unavailable",
      message: "adapter does not declare blue-green; planning must choose a degraded strategy or adapter",
      missingCapability: "blue-green",
    },
    {
      code: "delivery.capability_unavailable",
      message: "adapter does not declare automated-rollback; planning must choose a degraded strategy or adapter",
      missingCapability: "automated-rollback",
    },
  ]);
  assert.deepEqual(started.events[0].data.warnings, started.status.warnings);
});

test("promote on an already promoted rollout is idempotent", () => {
  const adapter = createDeliveryAdapter({ supportedCapabilities: ["canary"] });
  adapter.start({
    rolloutId: "rollout_idempotent",
    runId: "run_idempotent",
    tenant: "tenant_a",
    target: {
      service: "checkout-web",
      fromVersion: "checkout@sha256:old",
      toVersion: "checkout@sha256:new",
    },
    policy: {
      strategy: "canary",
      steps: [{ name: "full", weight: 100, gateRefs: [] }],
      analysisWindow: { durationSeconds: 1, minSamples: 0 },
      requiredCapabilities: ["canary"],
    },
  });
  adapter.step({ rolloutId: "rollout_idempotent", step: "full" });

  const first = adapter.promote({ rolloutId: "rollout_idempotent" });
  const second = adapter.promote({ rolloutId: "rollout_idempotent" });

  assert.equal(first.events.length, 1);
  assert.deepEqual(second.status, first.status);
  assert.deepEqual(second.events, []);
});
