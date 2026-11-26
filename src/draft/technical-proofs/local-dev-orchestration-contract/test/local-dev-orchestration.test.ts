import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildLocalDevGraph,
  createLocalDevOrchestrator,
  reverseDependencyOrder,
} from "../src/local-dev-orchestration.js";

function orchestrator(options = {}) {
  let nextId = 1;
  return createLocalDevOrchestrator({
    now: () => "2026-07-02T00:00:00.000Z",
    idFactory: (prefix) => `${prefix}-${nextId++}`,
    ...options,
  });
}

const multiServiceManifest = {
  sessionId: "dev-session-snapshop",
  resources: [
    {
      id: "db",
      deps: [],
      annotations: { healthCheck: true, lifetime: "persistent" },
    },
    {
      id: "api",
      deps: ["db"],
      env: { ConnectionStrings__db: "{db.connectionString}" },
      annotations: { waitFor: ["db"], healthCheck: true, endpointExternal: true },
    },
    {
      id: "worker",
      deps: ["api"],
      annotations: { scaling: { min: 1, max: 10 }, residency: "us-west" },
    },
  ],
};

test("dependency-gated startup activates db before api before worker", async () => {
  const result = orchestrator().run({
    manifest: multiServiceManifest,
    healthOutcomes: { db: true, api: true },
  });

  assert.deepEqual(
    result.activationLog.map((entry) => entry.resourceId),
    ["db", "api", "worker"],
  );
  assert.equal(result.activationLog[0].wave, 0);
  assert.equal(result.activationLog[1].wave, 1);
  assert.equal(result.activationLog[2].wave, 2);
  assert.deepEqual(result.state.readyResourceIds, ["api", "db", "worker"]);
  assert.deepEqual(result.shutdownOrder, ["worker", "api", "db"]);
});

test("waitFor and health gates keep dependents in Starting until producer is Ready", async () => {
  const result = orchestrator().run({
    manifest: multiServiceManifest,
    healthOutcomes: { db: false },
  });

  assert.deepEqual(result.state.readyResourceIds, []);
  assert.deepEqual(result.state.waitingResourceIds, ["api", "db", "worker"]);
  assert.equal(result.events.filter((event) => event.type === "local.Ready").length, 0);
  assert.ok(result.events.some((event) => event.type === "local.Starting" && event.resourceId === "db"));
});

test("waitForCompletion blocks dependents until a job exits zero", async () => {
  const manifest = {
    sessionId: "dev-session-migrate",
    resources: [
      { id: "db", deps: [] },
      { id: "migrate", kind: "job", deps: ["db"] },
      {
        id: "api",
        deps: ["db"],
        annotations: { waitForCompletion: ["migrate"] },
      },
    ],
  };

  const blocked = orchestrator().run({
    manifest,
    jobExitCodes: {},
  });

  assert.deepEqual(blocked.state.readyResourceIds, ["db"]);
  assert.deepEqual(blocked.state.waitingResourceIds, ["api", "migrate"]);

  const ready = orchestrator().run({
    manifest,
    jobExitCodes: { migrate: 0 },
  });

  assert.deepEqual(ready.state.readyResourceIds, ["api", "db", "migrate"]);
  assert.ok(
    ready.events.findIndex((event) => event.type === "local.Ready" && event.resourceId === "migrate") <
      ready.events.findIndex((event) => event.type === "local.Starting" && event.resourceId === "api"),
  );
});

test("non-zero job exit surfaces local.StartFailed and leaves dependents waiting", async () => {
  const manifest = {
    sessionId: "dev-session-failed-job",
    resources: [
      { id: "migrate", kind: "job", deps: [] },
      { id: "api", deps: [], annotations: { waitForCompletion: ["migrate"] } },
    ],
  };

  const result = orchestrator().run({
    manifest,
    jobExitCodes: { migrate: 1 },
  });

  assert.deepEqual(result.state.failedResourceIds, ["migrate"]);
  assert.deepEqual(result.state.readyResourceIds, []);
  assert.ok(result.events.some((event) => event.type === "local.StartFailed" && event.resourceId === "migrate"));
});

test("withExplicitStartup keeps a resource stopped until manually started", async () => {
  const manifest = {
    sessionId: "dev-session-explicit",
    resources: [
      { id: "db", deps: [] },
      {
        id: "batch",
        deps: ["db"],
        annotations: { explicitStartup: true },
      },
    ],
  };

  const blocked = orchestrator().run({ manifest });
  assert.deepEqual(blocked.state.readyResourceIds, ["db"]);
  assert.deepEqual(blocked.state.waitingResourceIds, ["batch"]);

  const started = orchestrator().run({
    manifest,
    manualStarts: ["batch"],
  });
  assert.deepEqual(started.state.readyResourceIds, ["batch", "db"]);
});

test("withExplicitStartup auto-starts when every waitFor target is Ready", async () => {
  const manifest = {
    sessionId: "dev-session-explicit-waitfor",
    resources: [
      { id: "db", deps: [] },
      {
        id: "batch",
        deps: ["db"],
        annotations: { explicitStartup: true, waitFor: ["db"] },
      },
    ],
  };

  const result = orchestrator().run({ manifest });
  assert.deepEqual(result.state.readyResourceIds, ["batch", "db"]);
});

test("independent roots activate in the same wave", async () => {
  const manifest = {
    sessionId: "dev-session-parallel",
    resources: [
      { id: "cache", deps: [] },
      { id: "db", deps: [] },
      { id: "api", deps: ["db", "cache"] },
    ],
  };

  const result = orchestrator().run({ manifest });
  const waveZero = result.activationLog.filter((entry) => entry.wave === 0).map((entry) => entry.resourceId);
  assert.deepEqual(waveZero.sort(), ["cache", "db"]);
});

test("external endpoints publish a host-reachable label on Ready", async () => {
  const result = orchestrator().run({
    manifest: multiServiceManifest,
    healthOutcomes: { db: true, api: true },
  });

  const apiReady = result.events.find((event) => event.type === "local.Ready" && event.resourceId === "api");
  assert.equal(apiReady.data.endpointExternal, true);
  assert.equal(apiReady.data.endpointLabel, "external:localhost");
});

test("lazy env refs resolve only after producer Ready", async () => {
  const result = orchestrator().run({
    manifest: multiServiceManifest,
    healthOutcomes: { db: true, api: true },
  });

  const apiReady = result.events.find((event) => event.type === "local.Ready" && event.resourceId === "api");
  assert.deepEqual(apiReady.data.resolvedEnv, { ConnectionStrings__db: "db.ready" });
});

test("replicas and scaling collapse to a single local instance label", async () => {
  const result = orchestrator().run({ manifest: multiServiceManifest, healthOutcomes: { db: true, api: true } });
  const workerReady = result.events.find((event) => event.type === "local.Ready" && event.resourceId === "worker");
  assert.equal(workerReady.data.replicas, 1);
  assert.equal(workerReady.data.scalingLabel, "scaling: local-fixed-1");
  assert.equal(workerReady.data.residencyLabel, "us-west");
});

test("dependency cycles fail closed at graph build time", () => {
  assert.throws(
    () =>
      buildLocalDevGraph({
        sessionId: "cycle",
        resources: [
          { id: "a", deps: ["b"] },
          { id: "b", deps: ["a"] },
        ],
      }),
    /cycle/i,
  );
});

test("reverseDependencyOrder matches startup inverse for shutdown", () => {
  const graph = buildLocalDevGraph(multiServiceManifest);
  const order = reverseDependencyOrder([...graph.resources.values()]).map((resource) => resource.id);
  assert.deepEqual(order, ["worker", "api", "db"]);
});
