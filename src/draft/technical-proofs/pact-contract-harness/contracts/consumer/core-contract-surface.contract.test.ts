import path from "node:path";
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  checkPactInventory,
  createMockProviderFromPact,
  loadPactDirectory,
} from "../../src/index.js";
import {
  fetchCoreContractSurface,
  fetchUnsupportedSchemaError,
} from "./core-reference-consumer.js";

const contractsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("core-contract-surface consumer contract", () => {
  it("satisfies the pact via mock provider and inventory gate", async () => {
    const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
    const pact = pacts.find((entry) => entry.provider.name === "CoreContractSurface");
    assert.ok(pact);

    const mockProvider = createMockProviderFromPact(pact);
    const surface = await fetchCoreContractSurface(mockProvider);

    assert.equal(surface.schemaVersion, "hobo.core/v1");
    assert.equal(surface.eventMappings.cloudEventSpecversion, "1.0");

    const error = await fetchUnsupportedSchemaError(mockProvider, "hobo.core/v0");
    assert.equal(error.code, "HOBO_CORE_UNSUPPORTED_SCHEMA");

    const inventory = await checkPactInventory(contractsDir);
    assert.equal(inventory.ok, true);
  });
});
