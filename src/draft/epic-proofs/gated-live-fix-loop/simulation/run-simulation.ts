import { readFile } from "node:fs/promises";

import { runGatedLiveFixLoop } from "../services/gated-live-fix-loop.js";

const fixtureUrl = new URL("./fixtures/gated-live-fix-loop-fixture.json", import.meta.url);

async function main() {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const result = runGatedLiveFixLoop(fixture);

  const summary = {
    issue: "HOBO-654",
    status: result.status,
    applied: result.applied,
    needsApproval: result.needsApproval,
    sloTrigger: result.sloTrigger,
    canaryGate: result.canaryGate,
    regressionTestIds: result.regressionTests.map((entry) => entry.id),
    eventTypes: result.events.map((event) => event.type),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
