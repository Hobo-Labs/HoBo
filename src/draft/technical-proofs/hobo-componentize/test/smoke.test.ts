import { describe, expect, it } from "vitest";

import { runComponentSmoke, validateWasmComponentArtifact } from "../src/index.js";
import { buildHelloBindle, componentizeRealBuildSkipReason } from "./helpers.js";

const realBuildIt = componentizeRealBuildSkipReason ? it.skip : it;

describe("componentize smoke", () => {
  realBuildIt("invokes health via jco transpile and returns hello-bindle:ok", async () => {
    const result = await buildHelloBindle();
    expect(validateWasmComponentArtifact(result.component).passed).toBe(true);

    const smoke = await runComponentSmoke(result.component, { exportName: "health" });
    expect(smoke.exitCode).toBe(0);
    expect(smoke.stdout).toBe("hello-bindle:ok\n");
  }, 240_000);

  realBuildIt("throws for unknown exports", async () => {
    const result = await buildHelloBindle();
    await expect(runComponentSmoke(result.component, { exportName: "missing" })).rejects.toThrow(
      /componentize\.unknown_export: missing/,
    );
  }, 240_000);
});
