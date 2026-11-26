import { runControlPlaneReferenceSimulation } from "../services/control-plane-reference-architecture.js";

const result = await runControlPlaneReferenceSimulation();

if (result.contracts.missing.length > 0) {
  throw new Error(`Missing contract decisions: ${result.contracts.missing.join(", ")}`);
}

if (result.liveNetworkCalls.length > 0) {
  throw new Error(`Simulation attempted live network calls: ${result.liveNetworkCalls.join(", ")}`);
}

console.log(JSON.stringify({
  epic: result.epic,
  planHash: result.plan.contentHash,
  resources: result.plan.resources.length,
  bddScenarios: result.bddScenarios.length,
  pactBoundariesCovered: result.contracts.covered.length,
  actorOrder: result.orchestrator.actorOrder,
  driftActions: result.drift.actions,
  bootstrapHandover: result.bootstrap.handoverPoint,
  liveNetworkCalls: result.liveNetworkCalls
}, null, 2));
