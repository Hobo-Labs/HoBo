import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	createMockProviderFromPact,
	loadPactDirectory,
} from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { must } from "../../src/total-access.js";
import {
	fetchCoreContractSurface,
	fetchUnsupportedSchemaError,
} from "./core-reference-consumer.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("core-contract-surface consumer contract", () => {
	it("satisfies the pact via mock provider and inventory gate", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find(
			(entry) => entry.provider.name === "CoreContractSurface",
		);
		expect(pact).toBeDefined();

		const mockProvider = createMockProviderFromPact(must(pact));
		const surface = await fetchCoreContractSurface(mockProvider);

		expect(surface.schemaVersion).toBe("hobo.core/v1");
		expect(surface.eventMappings.cloudEventSpecversion).toBe("1.0");

		const error = await fetchUnsupportedSchemaError(
			mockProvider,
			"hobo.core/v0",
		);
		expect(error.code).toBe("HOBO_CORE_UNSUPPORTED_SCHEMA");

		const inventory = await checkPactInventory(contractsDir);
		expect(inventory.ok).toBe(true);
	});
});
