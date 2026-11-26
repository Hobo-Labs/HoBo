import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { isJsonString } from "../src/json.js";
import { BOUNDARY_CONTRACTS } from "../services/reference-architecture.js";
import {
  loadPactContracts,
  validatePactInventoryCoverage,
} from "../adapters/pact-contracts.js";

describe("Pact-style boundary contracts", () => {
  it("has one consumer-driven contract for every declared service boundary", async () => {
    const contracts = await loadPactContracts();
    const coverage = validatePactInventoryCoverage(BOUNDARY_CONTRACTS, contracts);

    assert.deepEqual(coverage, {
      ok: true,
      missing: [],
      extra: [],
    });
    assert.equal(contracts.length, BOUNDARY_CONTRACTS.length);
  });

  it("keeps contracts focused on boundary compatibility", async () => {
    const contracts = await loadPactContracts();

    for (const contract of contracts) {
      assert.equal(contract.metadata.epic, "contracts-policy-governance");
      assert.equal(contract.metadata.pactSpecification.version, "3.0.0");
      assert.equal(isJsonString(contract.consumer.name), true);
      assert.equal(isJsonString(contract.provider.name), true);
      assert.ok(contract.interactions.length > 0);
      assert.ok(contract.interactions.every((interaction) => interaction.description));
      assert.ok(contract.interactions.every((interaction) => interaction.providerStates.length > 0));
    }
  });

  it("documents provider-unavailable mocks instead of omitting external boundaries", async () => {
    const contracts = await loadPactContracts();
    const byBoundary = new Map(contracts.map((contract) => [contract.metadata.boundary, contract]));

    assert.equal(byBoundary.get("Gatekeeper to Cost/Quota Policy").metadata.status, "mocked_provider_unavailable");
    assert.equal(
      byBoundary.get("Gatekeeper to Artifact Provenance Verifier").metadata.status,
      "mocked_provider_unavailable",
    );
    assert.equal(byBoundary.get("Governance Suite to Evidence Store").metadata.status, "mocked_provider_unavailable");
  });
});
