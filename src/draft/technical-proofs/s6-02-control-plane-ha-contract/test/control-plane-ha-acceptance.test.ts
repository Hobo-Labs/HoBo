import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONTROL_PLANE_AVAILABILITY_TARGET,
  NFR_009_RESUME_BUDGET_MS,
  QuorumRejectedError,
  StaleFenceError,
  createLeaderElection,
  createManualClock,
  createQuorumEventStore,
  runAvailabilitySoak,
  runLeaderKillMidDeployChaos,
} from "../src/control-plane-ha.js";

test("Given a Yard leader mid-deploy When chaos kills the leader Then a follower resumes within NFR-009", () => {
  const outcome = runLeaderKillMidDeployChaos();

  assert.equal(outcome.killedLeader, "yard-a");
  assert.equal(outcome.successor, "yard-b");
  assert.ok(outcome.withinNfr009, `recovery ${outcome.recoveryMs}ms must be < ${NFR_009_RESUME_BUDGET_MS}ms`);
  assert.equal(outcome.completed, true);
  assert.equal(outcome.fencingVerified, true);
  assert.equal(outcome.noDuplicateResourceActions, true);
});

test("Given a minority partition When quorum append is attempted Then writes are rejected", () => {
  const store = createQuorumEventStore({
    quorumSize: 3,
    healthyNodes: ["node-1"],
  });

  assert.throws(
    () =>
      store.appendFenced({
        streamId: "control-plane/streams",
        fenceToken: 1n,
        eventType: "yard.LeaderElected",
      }),
    QuorumRejectedError,
  );
});

test("Given a stale fenced leader When it appends after successor takeover Then duplicate resource actions are blocked", () => {
  const clock = createManualClock();
  const store = createQuorumEventStore({ clock, quorumSize: 3, healthyNodes: ["a", "b", "c"] });
  const election = createLeaderElection({ clock, leaseTtlMs: 1_000 });

  const first = election.tryAcquire("yard-a");
  store.appendFenced({
    streamId: "control-plane/deploy",
    fenceToken: first.fenceToken,
    eventType: "deploy.Started",
    actionId: "deploy-1",
  });

  election.killLeader();
  clock.advance(1_001);
  const second = election.tryAcquire("yard-b");
  store.appendFenced({
    streamId: "control-plane/deploy",
    fenceToken: second.fenceToken,
    eventType: "yard.LeaderElected",
  });

  assert.throws(
    () =>
      store.appendFenced({
        streamId: "control-plane/deploy",
        fenceToken: first.fenceToken,
        eventType: "deploy.DatabaseProvisioned",
        actionId: "database-primary",
      }),
    StaleFenceError,
  );

  store.appendFenced({
    streamId: "control-plane/deploy",
    fenceToken: second.fenceToken,
    eventType: "deploy.DatabaseProvisioned",
    actionId: "database-primary",
  });

  const actionIds = store
    .readStream("control-plane/deploy")
    .map((event) => event.actionId)
    .filter(Boolean);
  assert.deepEqual(actionIds, ["deploy-1", "database-primary"]);
});

test("Given a soak lane with bounded outages When availability is computed Then control-plane meets 99.9%", () => {
  const soak = runAvailabilitySoak({
    windows: 1_000,
    outageWindows: 1,
    windowMs: 60_000,
    outageMs: 30,
  });

  assert.ok(soak.availability >= CONTROL_PLANE_AVAILABILITY_TARGET);
  assert.equal(soak.meetsTarget, true);
});

test("Leader election rejects concurrent singleton claims until lease expiry", () => {
  const clock = createManualClock();
  const election = createLeaderElection({ clock, leaseTtlMs: 500 });

  election.tryAcquire("drift-scheduler-a");
  assert.throws(() => election.tryAcquire("drift-scheduler-b"), /leader held/i);

  clock.advance(501);
  const successor = election.tryAcquire("drift-scheduler-b");
  assert.equal(successor.nodeId, "drift-scheduler-b");
  assert.equal(successor.fenceToken, 2n);
});
