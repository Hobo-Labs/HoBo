import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONTRACT_BOUNDARIES,
  runControlPlaneReferenceSimulation
} from "../services/control-plane-reference-architecture.js";

test("plans and matches a Bindle into a deterministic DeploymentPlan", async () => {
  const result = await runControlPlaneReferenceSimulation();

  assert.equal(result.epic.slug, "control-plane-planner-matching-orchestrator");
  assert.equal(result.plan.contentHash, "sha256:control-plane-reference-001");
  assert.deepEqual(result.plan.resources.map((resource) => resource.name), [
    "orders-db",
    "checkout-api",
    "web-edge",
    "receipt-worker"
  ]);
  assert.deepEqual(result.plan.dependencyOrder, ["orders-db", "checkout-api", "web-edge", "receipt-worker"]);
  assert.equal(result.matching.decisions.every((decision) => decision.catalogHash === "sha256:catalog-control-plane-001"), true);
  assert.equal(result.capabilityFeedback.rejections[0].code, "capability.required-not-satisfied");
  assert.equal(result.liveNetworkCalls.length, 0);
});

test("applies a Delta to a Set and reconciles resources through actors and executors", async () => {
  const result = await runControlPlaneReferenceSimulation();

  assert.equal(result.delta.appliedSetRef, "set:checkout-prod@sha256:002");
  assert.deepEqual(result.orchestrator.actorOrder, ["orders-db", "checkout-api", "web-edge", "receipt-worker"]);
  assert.equal(result.orchestrator.events.includes("resource.Provisioned:checkout-api"), true);
  assert.equal(result.executor.sandbox, "firecracker");
  assert.equal(result.executor.ambientCredentials, false);
  assert.equal(result.driverDispatch.selectedDrivers.includes("terraform"), true);
  assert.equal(result.driverDispatch.selectedDrivers.includes("custom-webhook"), true);
});

test("fails closed on drift, partial realize, and dispatcher double spend", async () => {
  const result = await runControlPlaneReferenceSimulation();

  assert.equal(result.drift.loopDetected, true);
  assert.equal(result.drift.actions.includes("orphan-sweep"), true);
  assert.equal(result.partialRealize.compensation.status, "rolled_back_with_orphan_recorded");
  assert.equal(result.partialRealize.createdButNotInState.safe, true);
  assert.equal(result.dispatcher.firstReservation.status, "reserved");
  assert.equal(result.dispatcher.secondReservation.status, "cas_rejected");
  assert.equal(result.deploymentView.correlationComplete, true);
});

test("bootstraps a self-host Yard with explicit identity handover", async () => {
  const result = await runControlPlaneReferenceSimulation();

  assert.equal(result.bootstrap.seedCredentialUse, "single_use_operator_svid");
  assert.equal(result.bootstrap.handoverPoint, "real_identity_broker_ready");
  assert.equal(result.bootstrap.replayImported, true);
  assert.equal(result.bootstrap.secondBootstrapBlocked, true);
  assert.equal(result.adoptInPlace.legacyDb.lifecycle, "drift-detect-only");
});

test("covers every declared boundary with a Pact decision", async () => {
  const result = await runControlPlaneReferenceSimulation();

  assert.equal(CONTRACT_BOUNDARIES.length, 13);
  assert.deepEqual([...result.contracts.covered].sort(), CONTRACT_BOUNDARIES.map((boundary) => boundary.provider).sort());
  assert.deepEqual(result.contracts.missing, []);
});
