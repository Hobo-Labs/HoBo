import { runSdkAuthoringReferenceSimulation } from "../services/sdk-authoring-reference-architecture.js";

const result = await runSdkAuthoringReferenceSimulation();

if (result.contracts.missing.length > 0) {
  throw new Error(`Missing contract decisions: ${result.contracts.missing.join(", ")}`);
}

if (result.liveNetworkCalls.length > 0) {
  throw new Error(`Simulation attempted live network calls: ${result.liveNetworkCalls.join(", ")}`);
}

console.log(JSON.stringify({
  epic: result.epic,
  manifestHash: result.manifest.contentHash,
  bddScenarios: result.bddScenarios.length,
  resources: result.manifest.resources.length,
  pactBoundariesCovered: result.contracts.covered.length,
  generatedFiles: result.codegen.generatedFiles.length,
  localReplay: result.localRuntime.replayEqualsLive,
  liveNetworkCalls: result.liveNetworkCalls
}, null, 2));
