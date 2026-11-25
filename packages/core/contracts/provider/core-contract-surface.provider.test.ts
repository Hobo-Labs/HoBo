import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory, verifyPact } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { must } from "../../src/total-access.js";
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
		const pact = pacts.find(
			(entry) => entry.provider.name === "CoreContractSurface",
		);
		expect(pact).toBeDefined();

		const good = await verifyPact(must(pact), coreContractSurfaceStub);
		expect(good.ok).toBe(true);
		expect(good.failures).toHaveLength(0);

		const bad = await verifyPact(must(pact), skewedProviderStub);
		expect(bad.ok).toBe(false);
		expect(
			bad.failures.some((failure) => failure.reason.includes("schemaVersion")),
		).toBe(true);
	});
});
