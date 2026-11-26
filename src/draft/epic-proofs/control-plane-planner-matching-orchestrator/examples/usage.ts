/**
 * Runnable example for control-plane-planner-matching-orchestrator. The draft-artifact
 * gate EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Runs the same reference simulation the cucumber steps drive
 * (services/control-plane-reference-architecture.ts): deterministic planning,
 * dependency-ordered reconciliation, drift/partial-realize recovery, and bootstrap handover.
 */
import { strict as assert } from "node:assert";

import { runControlPlaneReferenceSimulation } from "../services/control-plane-reference-architecture.ts";

const result = await runControlPlaneReferenceSimulation();
assert.equal(result.epic.slug, "control-plane-planner-matching-orchestrator");

// 1) Planner: deterministic DeploymentPlan with pinned matching decisions, no live calls.
assert.equal(result.plan.contentHash, "sha256:control-plane-reference-001");
assert.deepEqual(result.plan.dependencyOrder, [
	"orders-db",
	"checkout-api",
	"web-edge",
	"receipt-worker",
]);
assert.equal(
	result.matching.decisions.every(
		(decision: { catalogHash: string }) =>
			decision.catalogHash === "sha256:catalog-control-plane-001",
	),
	true,
);
assert.equal(result.liveNetworkCalls.length, 0);
console.log(`plan hash=${result.plan.contentHash}`);
console.log(`dependency order=${result.plan.dependencyOrder.join(" -> ")}`);
console.log(
	`matching decisions=${result.matching.decisions.length} catalog-pinned liveCalls=${result.liveNetworkCalls.length}`,
);

// 2) Orchestrator: Delta promotes to a Set; actors reconcile in dependency order.
assert.equal(result.delta.appliedSetRef, "set:checkout-prod@sha256:002");
assert.deepEqual(result.orchestrator.actorOrder, [
	"orders-db",
	"checkout-api",
	"web-edge",
	"receipt-worker",
]);
assert.equal(
	result.orchestrator.events.includes("resource.Provisioned:checkout-api"),
	true,
);
assert.equal(result.executor.sandbox, "firecracker");
assert.equal(result.executor.ambientCredentials, false);
assert.equal(result.driverDispatch.selectedDrivers.includes("terraform"), true);
console.log(
	`delta applied=${result.delta.appliedSetRef} sandbox=${result.executor.sandbox} ambientCreds=${result.executor.ambientCredentials}`,
);

// 3) Drift + partial realization: rollback with orphan recorded; double-spend CAS-rejected.
assert.equal(result.drift.loopDetected, true);
assert.equal(result.drift.actions.includes("orphan-sweep"), true);
assert.equal(
	result.partialRealize.compensation.status,
	"rolled_back_with_orphan_recorded",
);
assert.equal(result.partialRealize.createdButNotInState.safe, true);
assert.equal(result.dispatcher.firstReservation.status, "reserved");
assert.equal(result.dispatcher.secondReservation.status, "cas_rejected");
console.log(
	`drift detected=${result.drift.loopDetected} compensation=${result.partialRealize.compensation.status}`,
);
console.log(
	`dispatch first=${result.dispatcher.firstReservation.status} second=${result.dispatcher.secondReservation.status}`,
);

// 4) Bootstrap: seed credential is single-use; handover retires it; re-bootstrap blocked.
assert.equal(result.bootstrap.seedCredentialUse, "single_use_operator_svid");
assert.equal(result.bootstrap.handoverPoint, "real_identity_broker_ready");
assert.equal(result.bootstrap.replayImported, true);
assert.equal(result.bootstrap.secondBootstrapBlocked, true);
console.log(
	`bootstrap seed=${result.bootstrap.seedCredentialUse} handover=${result.bootstrap.handoverPoint} rebootstrapBlocked=${result.bootstrap.secondBootstrapBlocked}`,
);

console.log(
	"EPIC HELD: plan, converge, recover, and bootstrap are deterministic behind mocked boundaries",
);
