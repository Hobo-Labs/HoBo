import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createInMemoryActorHost,
  createResourceActor,
  hydrateResourceActor
} from "../src/resourceactor-fsm-contract.js";

const plan = {
  deploymentId: "deploy-123",
  resource: {
    name: "api",
    type: "compute",
    desired: {
      image: "oci://registry.example/app@sha256:abc123"
    }
  }
};

test("ResourceActor drives the documented happy-path FSM and emits resource events", () => {
  const actor = createResourceActor(plan);

  actor.markDependenciesSatisfied();
  actor.previewOk({ programRef: "iac://deploy-123/api/preview-1" });
  actor.applyOk({ outputs: { url: "https://api.example.test" } });

  assert.equal(actor.key, "resource:deploy-123:api");
  assert.equal(actor.state, "Provisioned");
  assert.deepEqual(
    actor.events.map((event) => event.type),
    ["resource.Planning", "resource.Provisioning", "resource.Provisioned"]
  );
});

test("ResourceActor hydrates from its resource event stream after a crash", () => {
  const actor = createResourceActor(plan);

  actor.markDependenciesSatisfied();
  actor.previewOk({ programRef: "iac://deploy-123/api/preview-1" });

  const rehydrated = hydrateResourceActor(plan, actor.events);

  assert.equal(rehydrated.key, actor.key);
  assert.equal(rehydrated.state, "Provisioning");
  assert.deepEqual(rehydrated.events, actor.events);
});

test("ResourceActor emits the documented failure, compensation, destroy, and update transitions", () => {
  const failed = createResourceActor(plan);
  failed.markDependenciesSatisfied();
  failed.previewOk();
  failed.applyFailed({ class: "fatal-provider-error" });
  failed.rollbackRequested({ deploymentEvent: "deployment.RolledBack" });
  failed.compensationDone();

  assert.equal(failed.state, "Destroyed");
  assert.deepEqual(
    failed.events.map((event) => event.type),
    [
      "resource.Planning",
      "resource.Provisioning",
      "resource.Failed",
      "resource.Compensating",
      "resource.Destroyed"
    ]
  );

  const updating = createResourceActor(plan);
  updating.markDependenciesSatisfied();
  updating.previewOk();
  updating.applyOk();
  updating.desiredChanged({ diffRef: "iac://deploy-123/api/diff-2" });
  updating.updateOk({ outputs: { url: "https://api-v2.example.test" } });
  updating.destroyRequested();
  updating.destroyOk();

  assert.equal(updating.state, "Destroyed");
  assert.deepEqual(
    updating.events.map((event) => event.type),
    [
      "resource.Planning",
      "resource.Provisioning",
      "resource.Provisioned",
      "resource.Updating",
      "resource.Provisioned",
      "resource.Destroying",
      "resource.Destroyed"
    ]
  );
});

test("ActorHost lease fences out a second concurrent writer for the same resource", () => {
  const host = createInMemoryActorHost();
  const first = createResourceActor(plan);
  const second = createResourceActor(plan);

  const lease = first.activate(host, { ownerId: "worker-a" });

  assert.equal(lease.actorKey, "resource:deploy-123:api");
  assert.throws(
    () => second.activate(host, { ownerId: "worker-b" }),
    /lease held by worker-a/
  );

  lease.release();
  assert.equal(second.activate(host, { ownerId: "worker-b" }).ownerId, "worker-b");
});

test("ResourceActor rejects illegal transitions and ignores late duplicate events", () => {
  const actor = createResourceActor(plan);

  assert.throws(() => actor.applyOk(), /illegal ResourceActor transition/);

  actor.markDependenciesSatisfied();
  actor.previewOk();
  actor.applyOk();
  const priorEvent = actor.events[1];

  const observed = actor.ingestEvent(priorEvent);

  assert.equal(observed.accepted, false);
  assert.equal(observed.reason, "already-observed");
  assert.equal(actor.state, "Provisioned");
  assert.equal(actor.events.length, 3);
});

test("ResourceActor reconcile stub emits provisioning intent without running apply", () => {
  const actor = createResourceActor(plan);

  actor.markDependenciesSatisfied();
  const result = actor.reconcile({
    preview: {
      empty: false,
      programRef: "iac://deploy-123/api/program-1"
    }
  });

  assert.equal(actor.state, "Provisioning");
  assert.deepEqual(result, {
    kind: "needs-executor-dispatch",
    actorKey: "resource:deploy-123:api",
    programRef: "iac://deploy-123/api/program-1"
  });
  assert.equal(actor.events.at(-1).type, "resource.Provisioning");
  assert.equal(actor.events.some((event) => event.type === "exec.Succeeded"), false);
});
