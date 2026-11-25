import path from "node:path";
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPactDirectory, verifyPact } from "../../src/index.js";
import { coreContractSurfaceStub } from "./fixtures/core-contract-surface.stub.js";
import { skewedProviderStub } from "./fixtures/skewed-provider.stub.js";

const pactsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "pacts",
);

describe("core-contract-surface provider verification", () => {
  it("verifies the real stub and rejects the skewed stub", async () => {
    const pacts = await loadPactDirectory(pactsDir);
    const pact = pacts.find((entry) => entry.provider.name === "CoreContractSurface");
    assert.ok(pact);

    const good = await verifyPact(pact, coreContractSurfaceStub);
    assert.equal(good.ok, true);
    assert.equal(good.failures.length, 0);

    const bad = await verifyPact(pact, skewedProviderStub);
    assert.equal(bad.ok, false);
    assert.equal(
      bad.failures.some((failure) => failure.reason.includes("schemaVersion")),
      true,
    );
  });
});
