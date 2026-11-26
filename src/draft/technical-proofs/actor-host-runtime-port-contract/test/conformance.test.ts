import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createActorHostConformanceBackend,
  createBrokenFenceActorHostBackend,
  runActorHostConformance,
} from "../src/conformance/actor-host-checks.js";

test("actor-host conformance suite passes for runtime-local draft backend", async () => {
  const report = await runActorHostConformance(createActorHostConformanceBackend);

  assert.equal(report.status, "pass");
  assert.equal(report.backend, "runtime-local");
  assert.deepEqual(
    report.checks.map((check) => [check.checkId, check.status]),
    [
      ["actor-host.single-writer", "pass"],
      ["actor-host.stale-fence-rejected", "pass"],
      ["actor-host.expired-zombie-rejected", "pass"],
      ["actor-host.renewal-no-new-fence", "pass"],
      ["actor-host.forged-lease-rejected", "pass"],
      ["actor-host.snapshot-replay-parity", "pass"],
    ],
  );
});

test("broken-fence negative backend fails actor-host.stale-fence-rejected", async () => {
  const report = await runActorHostConformance(createBrokenFenceActorHostBackend);

  assert.equal(report.status, "fail");
  assert.equal(
    report.failures.find((failure) => failure.checkId === "actor-host.stale-fence-rejected")?.checkId,
    "actor-host.stale-fence-rejected",
  );
});
