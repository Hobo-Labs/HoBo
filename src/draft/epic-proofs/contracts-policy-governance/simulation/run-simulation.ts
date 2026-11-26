import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMockBoundaryHarness,
  runDenyCeilingBypassSimulation,
  runFailClosedSimulation,
  runGovernedDeploySimulation,
} from "../services/reference-architecture.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  await readFile(path.join(MODULE_DIR, "fixtures/secops-governance-fixture.json"), "utf8"),
);

const governed = await runGovernedDeploySimulation(createMockBoundaryHarness({ fixtures: fixture }));
const denyCeiling = await runDenyCeilingBypassSimulation(createMockBoundaryHarness({ fixtures: fixture }));
const failClosed = await runFailClosedSimulation(createMockBoundaryHarness({
  fixtures: fixture,
  policyProviderMode: "unavailable",
}));

const summary = {
  ok: governed.gatekeeper.deployable && !denyCeiling.gatekeeper.deployable && !failClosed.gatekeeper.deployable,
  scenarios: [
    {
      scenario: governed.scenario,
      deployable: governed.gatekeeper.deployable,
      boundaryCoverage: governed.coverage,
    },
    {
      scenario: denyCeiling.scenario,
      deployable: denyCeiling.gatekeeper.deployable,
      failures: denyCeiling.gatekeeper.failures.map((failure) => failure.reason),
    },
    {
      scenario: failClosed.scenario,
      deployable: failClosed.gatekeeper.deployable,
      reason: failClosed.failClosedDecision.reason,
    },
  ],
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) {
  process.exitCode = 1;
}
