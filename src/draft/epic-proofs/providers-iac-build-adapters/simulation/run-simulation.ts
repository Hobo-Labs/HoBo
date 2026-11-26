import { runProvidersReferenceSimulation } from "../services/providers-reference-architecture.js";

const result = await runProvidersReferenceSimulation();

if (result.contracts.missing.length > 0) {
  throw new Error(`Missing contract decisions: ${result.contracts.missing.join(", ")}`);
}

if (result.liveNetworkCalls.length > 0) {
  throw new Error(`Simulation attempted live network calls: ${result.liveNetworkCalls.join(", ")}`);
}

console.log(JSON.stringify({
  epic: result.epic,
  providers: result.providerCatalog.providers.length,
  bddScenarios: result.bddScenarios.length,
  pactBoundariesCovered: result.contracts.covered.length,
  realizePipeline: result.realize.pipeline,
  conformanceCovered: result.conformance.claimedPortsCovered,
  multiCloudShop: result.multiCloudShop,
  liveNetworkCalls: result.liveNetworkCalls
}, null, 2));
