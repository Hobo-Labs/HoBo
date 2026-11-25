import { runCrewReferenceSimulation } from "../services/crew-reference-architecture.js";

const result = await runCrewReferenceSimulation({
  humanDecisions: { "prod-contract-skew": "approve" },
});

for (const scenario of result.scenarios) {
  console.log(`${scenario.id}: ${scenario.status}`);
}

console.log(`mocked boundary calls: ${result.boundaryCalls.length}`);
console.log(`live network calls: ${result.liveNetworkCalls.length}`);
