import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createMockPostgresEventStore,
  runHoboYardUp,
} from "../src/yard-shell.js";

describe("cloud Yard shell (HOBO-618)", () => {
  it("hobo yard up boots a local Yard with gateway, postgres event store, and projection host", () => {
    const yard = runHoboYardUp();

    assert.equal(yard.status, "running");
    assert.equal(yard.runtime, "@hobo/runtime-postgres-mock");
    assert.ok(yard.gateway);
    assert.ok(yard.eventStore);
    assert.ok(yard.projectionHost);
    assert.equal(yard.bootEvents.length, 1);
    assert.equal(yard.bootEvents[0].type, "yard.Started");
  });

  it("DeployRequested command lands as an append-only event via REST ingress", () => {
    const yard = runHoboYardUp();
    const response = yard.gateway.handleRest({
      method: "POST",
      path: "/v1/commands/deploy",
      headers: { Authorization: "Bearer yard-svid:alice@camp-prod" },
      body: deployBody(),
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.accepted, true);
    assert.equal(response.body.eventType, "deployment.DeployRequested");
    assert.equal(response.body.seq, 1);

    const stream = yard.eventStore.read("deployment:checkout-prod");
    assert.equal(stream.length, 1);
    assert.equal(stream[0].type, "deployment.DeployRequested");
    assert.equal(stream[0].data.principal, "alice");
  });

  it("DeployRequested command lands via RPC ingress with the same append-only semantics", () => {
    const yard = runHoboYardUp();
    const response = yard.gateway.handleRpc({
      method: "Deploy",
      authorization: "Bearer yard-svid:alice@camp-prod",
      params: deployBody(),
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.eventType, "deployment.DeployRequested");
    assert.equal(yard.eventStore.readAll().filter((event) => event.type === "deployment.DeployRequested").length, 1);
  });

  it("deployment timeline projection rebuilds identically from the log (NFR-008)", () => {
    const yard = runHoboYardUp();
    yard.gateway.handleRest(restDeployRequest());

    const events = yard.eventStore.readAll();
    const liveTimeline = yard.projectionHost.readTimeline({ deploymentId: "deploy:checkout-prod:001" });
    const replay = yard.projectionHost.assertReplayEquivalent(events);

    assert.deepEqual(liveTimeline.graphNodes, ["DeployRequested"]);
    assert.equal(liveTimeline.correlationComplete, false);
    assert.ok(replay.state.timelines.some((timeline) => timeline.deploymentId === "deploy:checkout-prod:001"));
    assert.deepEqual(
      yard.projectionHost.rebuildFromLog(events).timelines,
      yard.projectionHost.liveState().timelines,
    );
  });

  it("rejects unauthenticated deploy commands without appending events", () => {
    const yard = runHoboYardUp();
    const response = yard.gateway.handleRest({
      method: "POST",
      path: "/v1/commands/deploy",
      body: deployBody(),
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.accepted, false);
    assert.equal(yard.eventStore.readAll().filter((event) => event.type === "deployment.DeployRequested").length, 0);
  });

  it("rejects cross-camp authorization without appending events", () => {
    const yard = runHoboYardUp();
    const response = yard.gateway.handleRest({
      method: "POST",
      path: "/v1/commands/deploy",
      headers: { Authorization: "Bearer yard-svid:alice@camp-staging" },
      body: deployBody(),
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.reason, "camp-mismatch");
    assert.equal(yard.eventStore.readAll().filter((event) => event.type === "deployment.DeployRequested").length, 0);
  });

  it("resumes yard shell after crash with identical timeline projection from the log", () => {
    const eventStore = createMockPostgresEventStore();
    const first = runHoboYardUp({ eventStore });
    first.gateway.handleRest(restDeployRequest());

    const eventsBeforeCrash = eventStore.readAll();
    const resumed = runHoboYardUp({ eventStore, skipBootEvents: true });
    for (const event of eventsBeforeCrash) {
      resumed.projectionHost.apply(event);
    }

    const timeline = resumed.projectionHost.readTimeline({ deploymentId: "deploy:checkout-prod:001" });
    assert.deepEqual(timeline.graphNodes, ["DeployRequested"]);
    assert.deepEqual(
      resumed.projectionHost.rebuildFromLog(eventsBeforeCrash).timelines,
      resumed.projectionHost.liveState().timelines,
    );
  });
});

function deployBody() {
  return {
    deploymentId: "deploy:checkout-prod:001",
    bindleRef: "@examples/hello-bindle",
    camp: "camp-prod",
    yard: "yard-local",
  };
}

function restDeployRequest() {
  return {
    method: "POST",
    path: "/v1/commands/deploy",
    headers: { Authorization: "Bearer yard-svid:alice@camp-prod" },
    body: deployBody(),
  };
}
