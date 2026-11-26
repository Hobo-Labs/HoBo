import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runConformanceSuite } from "../../src/index.ts";
import { subtractOutputAdapter } from "../../test/mutated-adapter.ts";
import { passingToyAdapter, toySuite } from "../../test/reference-adapter.ts";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../conformance-report.consumer.pact.json"),
		"utf8",
	),
);

describe("conformance report consumer boundary", () => {
	it("listed report satisfies CI-gate consumer expectations", async () => {
		const report = await runConformanceSuite(toySuite(), passingToyAdapter, {
			seed: "hobo-5-stable-seed",
		});

		const interaction = pact.interactions[0];
		expect(report.schema).toBe(interaction.response.body.schema);
		expect(report.ok).toBe(interaction.response.body.ok);
		expect(report.claim.status).toBe(interaction.response.body.claim.status);
		expect(report.claim.failureCodes).toEqual(
			interaction.response.body.claim.failureCodes,
		);
	});

	it("blocked report satisfies CI-gate consumer expectations", async () => {
		const report = await runConformanceSuite(
			toySuite(),
			subtractOutputAdapter,
			{
				seed: "hobo-5-stable-seed",
			},
		);

		const interaction = pact.interactions[1];
		expect(report.schema).toBe(interaction.response.body.schema);
		expect(report.ok).toBe(interaction.response.body.ok);
		expect(report.claim.status).toBe(interaction.response.body.claim.status);
		expect(report.claim.failureCodes.length).toBeGreaterThan(0);
		expect(report.claim.failureCodes).toContain("adapter.output-mismatch");
	});
});
