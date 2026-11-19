import { readFileSync } from "node:fs";
import { parsePactDocument, verifyPact } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import {
	computeAvailabilityView,
	parseAvailabilityViewRequest,
} from "../../src/index.js";
import { parseJsonValue } from "../../src/json.js";

const pact = parsePactDocument(
	parseJsonValue(
		readFileSync(
			new URL("../pacts/availability-view.pact.json", import.meta.url),
			"utf8",
		),
	),
);

describe("availability view provider contract", () => {
	it("computes each declared response from the protobuf request", async () => {
		const report = await verifyPact(pact, {
			name: "CloudAvailabilityView",
			handle: (request) => ({
				status: 200,
				body: computeAvailabilityView(
					parseAvailabilityViewRequest(
						parseJsonValue(JSON.stringify(request.body ?? null)),
					),
				),
			}),
		});
		expect(report.failures).toEqual([]);
		expect(report.ok).toBe(true);
	});
});
