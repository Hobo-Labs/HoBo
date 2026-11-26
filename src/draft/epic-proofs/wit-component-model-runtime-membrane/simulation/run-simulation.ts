import { runAllMembraneScenarios } from "../services/wit-runtime-reference.js";

const result = await runAllMembraneScenarios();

const failedScenario = result.scenarios.find((scenario) => scenario.liveNetworkCalls.length > 0);
if (failedScenario) {
  throw new Error(`Scenario ${failedScenario.id} attempted a live network call`);
}

console.log(JSON.stringify(result, null, 2));
