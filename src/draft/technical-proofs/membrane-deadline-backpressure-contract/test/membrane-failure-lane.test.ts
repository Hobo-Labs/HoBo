import assert from "node:assert/strict";
import { test } from "vitest";

import { runMembraneFailureLane } from "../src/index.js";

test("membrane failure lane passes all eight named assertions under 30s", async () => {
  const report = await runMembraneFailureLane();

  assert.equal(report.contract, "hobo.membrane-failure-lane/v1");
  assert.equal(report.issue, "HOBO-598");
  assert.ok(report.elapsedMs < 30_000, `lane took ${report.elapsedMs}ms`);
  assert.deepEqual(report.assertions, {
    slowProviderTypedTimeout: "pass",
    nestedDeadlineShrinks: "pass",
    hungProviderNeverHangs: "pass",
    boundedBackpressure: "pass",
    severedClassifiedPartial: "pass",
    eventStoreAppendDedup: "pass",
    providerRpcIdempotencyForwarded: "pass",
    retryStormShed: "pass",
  });
});
