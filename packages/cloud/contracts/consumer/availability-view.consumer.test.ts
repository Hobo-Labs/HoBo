import { readFileSync } from "node:fs";
import { fromJson } from "@bufbuild/protobuf";
import {
	createMockProviderFromPact,
	parsePactDocument,
} from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { AvailabilityViewSchema } from "../../src/index.js";
import { parseJsonValue } from "../../src/json.js";

const pact = parsePactDocument(
	parseJsonValue(
		readFileSync(
			new URL("../pacts/availability-view.pact.json", import.meta.url),
			"utf8",
		),
	),
);

describe("availability view consumer contract", () => {
	it("reads the estimated result and its deployment warning", async () => {
		const interaction = pact.interactions[0];
		if (interaction === undefined)
			throw new Error("missing estimate interaction");
		const response = await createMockProviderFromPact(pact).handle(
			interaction.request,
		);
		expect(response.status).toBe(200);
		const view = fromJson(
			AvailabilityViewSchema,
			parseJsonValue(JSON.stringify(response.body ?? null)),
		);
		expect(view.estimatedAvailability).toBe(0.9702);
		expect(view.canDeploy?.warnings[0]?.code).toBe("availability-floor-unmet");
	});

	it("reads an invalid graph without an estimate", async () => {
		const interaction = pact.interactions[1];
		if (interaction === undefined)
			throw new Error("missing invalid-graph interaction");
		const response = await createMockProviderFromPact(pact).handle(
			interaction.request,
		);
		expect(response.status).toBe(200);
		const view = fromJson(
			AvailabilityViewSchema,
			parseJsonValue(JSON.stringify(response.body ?? null)),
		);
		expect(view.status).toBe("invalid-graph");
		expect(view.estimatedAvailability).toBeUndefined();
		expect(view.errors[0]?.code).toBe("missing-node");
	});
});
