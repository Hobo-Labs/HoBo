import assert from "node:assert/strict";
import { test } from "vitest";

import {
  AVAILABILITY_VIEW_VERSION,
  computeAvailabilityView,
  formatAvailabilityPercent,
} from "../src/availability-view.js";

test("serial provider chain estimates fewer nines than any single provider", () => {
  const view = computeAvailabilityView({
    graph: {
      root: "web",
      nodes: {
        web: { availability: 0.999, dependsOn: ["api"] },
        api: { availability: 0.998, dependsOn: ["db"] },
        db: { availability: 0.9995 },
      },
      defaultHopAvailability: 0.9999,
    },
    observedAvailability: 0.997,
  });

  assert.equal(view.schema, AVAILABILITY_VIEW_VERSION);
  assert.equal(view.status, "estimated");
  assert.ok(view.estimatedAvailability < 0.998);
  assert.equal(view.summary.estimated, formatAvailabilityPercent(view.estimatedAvailability));
  assert.equal(view.summary.observed, "99.700%");
  assert.equal(view.summary.estimateObservedGap, "0.070%");
});

test("redundant pair composes parallel availability above either member", () => {
  const view = computeAvailabilityView({
    graph: {
      root: "api",
      nodes: {
        api: { availability: 0.999, dependsOn: ["db-replicas"] },
        "db-replicas": {
          type: "redundant-set",
          members: ["db-a", "db-b"],
        },
        "db-a": { availability: 0.99 },
        "db-b": { availability: 0.99 },
      },
    },
    observedAvailability: 0.998,
  });

  assert.ok(view.breakdown.byNode["db-replicas"].availability > 0.99);
  assert.equal(view.breakdown.byNode["db-replicas"].availability, 0.9999);
});

test("availabilitySlo floor emits a can-deploy warning, not a hard deny", () => {
  const view = computeAvailabilityView({
    graph: {
      root: "web",
      nodes: {
        web: { availability: 0.99, dependsOn: ["db"] },
        db: { availability: 0.99 },
      },
    },
    observedAvailability: 0.9995,
    availabilitySlo: 0.999,
  });

  assert.equal(view.canDeploy.effect, "warn");
  assert.deepEqual(view.canDeploy.warnings.map((warning) => warning.code), ["availability-floor-unmet"]);
  assert.equal(view.canDeploy.warnings[0].hardGate, false);
});

test("unrated provider uses conservative default and surfaces evidence", () => {
  const view = computeAvailabilityView({
    graph: {
      root: "api",
      nodes: {
        api: { availability: 0.999, dependsOn: ["search"] },
        search: { provider: "example-search" },
      },
    },
    conservativeUnratedAvailability: 0.95,
  });

  assert.equal(view.breakdown.byNode.search.availability, 0.95);
  assert.deepEqual(view.warnings.map((warning) => warning.code), ["unrated-provider"]);
});

test("cycles fail closed instead of emitting an optimistic estimate", () => {
  const view = computeAvailabilityView({
    graph: {
      root: "api",
      nodes: {
        api: { availability: 0.999, dependsOn: ["worker"] },
        worker: { availability: 0.999, dependsOn: ["api"] },
      },
    },
  });

  assert.equal(view.status, "invalid-graph");
  assert.equal(view.estimatedAvailability, null);
  assert.deepEqual(view.errors.map((error) => error.code), ["cycle-detected"]);
  assert.equal(view.canDeploy.effect, "warn");
});

test("shared dependency in redundant paths is counted once and flagged", () => {
  const view = computeAvailabilityView({
    graph: {
      root: "api",
      nodes: {
        api: { availability: 0.999, dependsOn: ["worker-pool"] },
        "worker-pool": {
          type: "redundant-set",
          members: ["worker-a", "worker-b"],
          sharedDependencies: ["queue"],
        },
        "worker-a": { availability: 0.98 },
        "worker-b": { availability: 0.98 },
        queue: { availability: 0.97 },
      },
    },
  });

  assert.equal(view.breakdown.byNode["worker-pool"].availability, 0.969612);
  assert.equal(view.breakdown.countedNodes.filter((node) => node === "queue").length, 1);
  assert.ok(view.warnings.some((warning) => warning.code === "redundancy-shared-failure-domain"));
});

test("shared dependency in separate graph paths is counted once", () => {
  const view = computeAvailabilityView({
    graph: {
      root: "api",
      nodes: {
        api: { availability: 0.99, dependsOn: ["worker", "reporter"] },
        worker: { availability: 0.99, dependsOn: ["queue"] },
        reporter: { availability: 0.99, dependsOn: ["queue"] },
        queue: { availability: 0.99 },
      },
    },
  });

  assert.equal(view.estimatedAvailability, 0.960596);
  assert.equal(view.breakdown.countedNodes.filter((node) => node === "queue").length, 1);
});

test("estimate versus observed divergence is surfaced, not hidden", () => {
  const view = computeAvailabilityView({
    graph: {
      root: "api",
      nodes: {
        api: { availability: 0.9999 },
      },
    },
    observedAvailability: 0.94,
    divergenceThreshold: 0.02,
  });

  assert.ok(view.warnings.some((warning) => warning.code === "estimate-observed-divergence"));
  assert.equal(view.summary.observed, "94.000%");
  assert.equal(view.summary.estimateObservedGap, "5.990%");
});
