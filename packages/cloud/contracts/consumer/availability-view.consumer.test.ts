import { fromJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AvailabilityViewSchema,
	computeAvailabilityView,
	parseAvailabilityViewRequest,
} from "../../src/index.js";
import { availabilityInteractions } from "../availability-view-fixture.js";

describe("availability view consumer contract", () => {
	it("reads the real estimator output through the declared protobuf boundary", () => {
		const interactions = availabilityInteractions();
		expect(interactions).toHaveLength(2);
		for (const interaction of interactions) {
			const actual = computeAvailabilityView(
				parseAvailabilityViewRequest(interaction.request),
			);
			expect(actual).toMatchObject(interaction.response);
			const view = fromJson(AvailabilityViewSchema, interaction.response);
			expect(view.status).toBe(actual.status);
			expect(view.estimatedAvailability ?? null).toBe(
				actual.estimatedAvailability,
			);
		}
	});
});
