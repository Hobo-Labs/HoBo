import { loadScenarioFixture, runHarnessScenario } from "../src/harness-reference.js";

const fixture = await loadScenarioFixture();
const results = {};

for (const [name, scenario] of Object.entries(fixture.scenarios)) {
  results[name] = await runHarnessScenario(scenario);
}

console.log(JSON.stringify(results, null, 2));
