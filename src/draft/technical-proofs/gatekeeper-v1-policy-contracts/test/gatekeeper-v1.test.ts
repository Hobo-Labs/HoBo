import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { allowWithCanaryFixture } from "../src/fixtures.js";
import {
  GATEKEEPER_V1_SCHEMA,
  runHoboVerifyDeploy,
  verifyDeployAtPoint,
} from "../src/gatekeeper-v1.js";

describe("Gatekeeper v1 deploy-point composition", () => {
  it("returns schema version and event-sourced deploy verification record", async () => {
    const result = await verifyDeployAtPoint({ fixtures: allowWithCanaryFixture() });

    assert.equal(result.schemaVersion, GATEKEEPER_V1_SCHEMA);
    assert.ok(result.events.some((event) => event.type === "gatekeeper.DeployVerified"));
    assert.ok(result.events.some((event) => event.type === "gatekeeper.VerifyPassed"));
  });

  it("runs hobo verify command shape with exit code from deployable state", async () => {
    const blocked = await runHoboVerifyDeploy(["--target", "prod"], allowWithCanaryFixture());
    assert.equal(blocked.command, "hobo verify");
    assert.equal(blocked.target, "prod");
    assert.equal(blocked.exitCode, 0);
  });
});
