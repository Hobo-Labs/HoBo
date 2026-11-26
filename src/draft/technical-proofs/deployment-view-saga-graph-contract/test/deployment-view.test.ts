import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DeploymentViewError,
  createDeploymentViewProjection,
  createInspectRunQuery,
} from "../src/deployment-view.js";

test("replays a fixture deploy into a saga graph from events only with match rationale", () => {
  const projection = createDeploymentViewProjection(completedDeployEvents().toReversed());

  const view = projection.inspectRun("deploy-382");

  assert.equal(view.contract, "hobo.deployment-view/v1");
  assert.equal(view.id, "deploy-382");
  assert.equal(view.correlationId, "deploy-382");
  assert.equal(view.status, "deployed");
  assert.equal(view.partial, false);
  assert.deepEqual(
    view.graph.edges,
    [{ from: "db", to: "api", kind: "depends-on" }],
  );
  assert.deepEqual(
    view.graph.nodes.map((node) => [node.id, node.state, node.provider, node.driver]),
    [
      ["db", "provisioned", "neon", "pulumi"],
      ["api", "provisioned", "aws", "pulumi"],
    ],
  );
  assert.equal(view.graph.nodes[0].match.winner, "neon-postgres-prod");
  assert.match(view.graph.nodes[0].match.rationale, /cost objective/);
  assert.deepEqual(
    view.timeline.map((entry) => entry.type),
    completedDeployEvents().map((event) => event.type),
  );
});

test("hobo inspect run query reads the event store projection and never touches providers", () => {
  let providerReads = 0;
  const query = createInspectRunQuery({
    eventStore: {
      readByCorrelationId(correlationId) {
        assert.equal(correlationId, "deploy-382");
        return completedDeployEvents();
      },
    },
    providerClient: {
      readLiveDeployment() {
        providerReads += 1;
        throw new Error("provider access is out of scope for DeploymentView");
      },
    },
  });

  const result = query.inspectRun("deploy-382");

  assert.equal(providerReads, 0);
  assert.equal(result.status, "deployed");
  assert.equal(result.graph.nodes.length, 2);
});

test("missing correlationId or causationId fails the end-to-end assertion", () => {
  const noCorrelation = completedDeployEvents();
  delete noCorrelation[4].correlationId;

  assert.throws(
    () => createDeploymentViewProjection(noCorrelation).inspectRun("deploy-382"),
    (error) =>
      error instanceof DeploymentViewError &&
      /correlationId/.test(error.message) &&
      /evt-5/.test(error.message),
  );

  const noCausation = completedDeployEvents();
  delete noCausation[5].causationId;

  assert.throws(
    () => createDeploymentViewProjection(noCausation).inspectRun("deploy-382"),
    (error) =>
      error instanceof DeploymentViewError &&
      /causationId/.test(error.message) &&
      /evt-6/.test(error.message),
  );
});

test("out-of-order delivery converges and concurrent deployments do not bleed correlationIds", () => {
  const mixed = [
    ...otherDeployEvents(),
    ...completedDeployEvents(),
  ].sort((left, right) => right.seq - left.seq);
  const projection = createDeploymentViewProjection(mixed);

  const main = projection.inspectRun("deploy-382");
  const other = projection.inspectRun("deploy-other");

  assert.deepEqual(main.graph.nodes.map((node) => node.id), ["db", "api"]);
  assert.deepEqual(other.graph.nodes.map((node) => node.id), ["worker"]);
  assert.ok(main.timeline.every((entry) => entry.correlationId === "deploy-382"));
  assert.ok(other.timeline.every((entry) => entry.correlationId === "deploy-other"));
});

test("partially rolled-back deployment renders compensation state", () => {
  const projection = createDeploymentViewProjection(partiallyRolledBackEvents());

  const view = projection.inspectRun("deploy-rollback");

  assert.equal(view.status, "rolled-back");
  assert.equal(view.partial, false);
  assert.deepEqual(
    view.graph.nodes.map((node) => [node.id, node.state]),
    [
      ["db", "destroyed"],
      ["api", "failed"],
    ],
  );
  assert.deepEqual(view.graph.rollback, [
    {
      resourceId: "db",
      state: "destroyed",
      reason: "rollback-after-api-failure",
      causedBy: "evt-rb-6",
    },
  ]);
});

test("in-flight deployment renders an honest partial graph", () => {
  const projection = createDeploymentViewProjection(inFlightEvents());

  const view = projection.inspectRun("deploy-live");

  assert.equal(view.status, "in-flight");
  assert.equal(view.partial, true);
  assert.deepEqual(
    view.graph.nodes.map((node) => [node.id, node.state]),
    [
      ["db", "provisioning"],
      ["api", "pending"],
    ],
  );
  assert.equal(view.timeline.at(-1).id, "evt-live-4");
});

function completedDeployEvents() {
  return [
    event(1, "deployment.Planned", {
      deploymentId: "deploy-382",
      plan: {
        nodes: [
          { id: "db", deps: [] },
          { id: "api", deps: ["db"] },
        ],
      },
    }),
    matchEvent(2, "db", "neon-postgres-prod", "cost objective picked managed Postgres"),
    matchEvent(3, "api", "aws-lambda-prod", "latency objective picked nearest compute"),
    event(4, "resource.Pending", { resourceId: "db", deps: [] }),
    event(5, "resource.Pending", { resourceId: "api", deps: ["db"] }),
    event(6, "resource.Provisioning", { resourceId: "db", provider: "neon", driver: "pulumi" }),
    event(7, "exec.Started", { execId: "exec-db", resourceId: "db", programHash: "sha256:db" }),
    event(8, "exec.Succeeded", { execId: "exec-db", outputsHash: "sha256:db-out" }),
    event(9, "resource.Provisioned", { resourceId: "db", outputs: { url: "postgres://db" } }),
    event(10, "resource.Provisioning", { resourceId: "api", provider: "aws", driver: "pulumi" }),
    event(11, "exec.Started", { execId: "exec-api", resourceId: "api", programHash: "sha256:api" }),
    event(12, "dispatch.Decided", {
      dispatchId: "build-api",
      category: "build-machine",
      selectedProvider: "depot",
      objective: "maximize-credits",
    }),
    event(13, "exec.Succeeded", { execId: "exec-api", outputsHash: "sha256:api-out" }),
    event(14, "resource.Provisioned", { resourceId: "api", outputs: { url: "https://api.example" } }),
    event(15, "deployment.Deployed", { deploymentId: "deploy-382", setId: "set-prod", resourceIds: ["db", "api"] }),
  ];
}

function partiallyRolledBackEvents() {
  return [
    event(1, "deployment.Planned", {
      deploymentId: "deploy-rollback",
      plan: {
        nodes: [
          { id: "db", deps: [] },
          { id: "api", deps: ["db"] },
        ],
      },
    }, { prefix: "evt-rb", correlationId: "deploy-rollback" }),
    event(2, "resource.Pending", { resourceId: "db", deps: [] }, { prefix: "evt-rb", correlationId: "deploy-rollback" }),
    event(3, "resource.Provisioned", { resourceId: "db", outputs: {} }, { prefix: "evt-rb", correlationId: "deploy-rollback" }),
    event(4, "resource.Pending", { resourceId: "api", deps: ["db"] }, { prefix: "evt-rb", correlationId: "deploy-rollback" }),
    event(5, "resource.Failed", { resourceId: "api", reason: "provider-timeout" }, { prefix: "evt-rb", correlationId: "deploy-rollback" }),
    event(6, "deployment.RolledBack", {
      deploymentId: "deploy-rollback",
      targetSetId: "set-prev",
      reason: "rollback-after-api-failure",
    }, { prefix: "evt-rb", correlationId: "deploy-rollback" }),
    event(7, "resource.Destroying", { resourceId: "db", reason: "rollback-after-api-failure" }, { prefix: "evt-rb", correlationId: "deploy-rollback" }),
    event(8, "resource.Destroyed", { resourceId: "db", finalStateHash: "sha256:destroyed" }, { prefix: "evt-rb", correlationId: "deploy-rollback" }),
  ];
}

function inFlightEvents() {
  return [
    event(1, "deployment.Planned", {
      deploymentId: "deploy-live",
      plan: {
        nodes: [
          { id: "db", deps: [] },
          { id: "api", deps: ["db"] },
        ],
      },
    }, { prefix: "evt-live", correlationId: "deploy-live" }),
    event(2, "resource.Pending", { resourceId: "db", deps: [] }, { prefix: "evt-live", correlationId: "deploy-live" }),
    event(3, "resource.Pending", { resourceId: "api", deps: ["db"] }, { prefix: "evt-live", correlationId: "deploy-live" }),
    event(4, "resource.Provisioning", { resourceId: "db", provider: "neon", driver: "pulumi" }, { prefix: "evt-live", correlationId: "deploy-live" }),
  ];
}

function otherDeployEvents() {
  return [
    event(1, "deployment.Planned", {
      deploymentId: "deploy-other",
      plan: { nodes: [{ id: "worker", deps: [] }] },
    }, { prefix: "evt-other", correlationId: "deploy-other" }),
    event(2, "resource.Pending", { resourceId: "worker", deps: [] }, { prefix: "evt-other", correlationId: "deploy-other" }),
    event(3, "resource.Provisioned", { resourceId: "worker", outputs: {} }, { prefix: "evt-other", correlationId: "deploy-other" }),
  ];
}

function matchEvent(seq, resourceId, winner, rationale) {
  return event(seq, "match.Decided", {
    resourceId,
    winner,
    objective: "cost",
    ranking: [
      {
        definitionId: winner,
        specificity: 3,
        priority: 10,
        objectiveScore: 0.1,
        rank: 1,
        rationale,
      },
    ],
    rejectedCandidates: [{ definitionId: `${resourceId}-fallback`, reason: "higher cost" }],
    tie: false,
    catalogContentHash: "sha256:catalog",
  });
}

function event(seq, type, data, options = {}) {
  const prefix = options.prefix ?? "evt";
  const correlationId = options.correlationId ?? "deploy-382";

  return {
    id: `${prefix}-${seq}`,
    seq,
    type,
    tenant: "tenant-a",
    time: `2026-06-28T00:${String(seq).padStart(2, "0")}:00.000Z`,
    actor: { kind: "service", id: "control-plane" },
    correlationId,
    causationId: seq === 1 ? `command:${correlationId}` : `${prefix}-${seq - 1}`,
    data,
  };
}
