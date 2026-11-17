import {
	evaluateResidency,
	jurisdictionsForRegion,
	parseResidencyConstraint,
} from "@hobo/core";
import { expect, test } from "vitest";

import { createAzureProvider } from "../src/provider.js";
import { azureYardRuntimeRegistration } from "../src/yard-defaults.js";

test("published Azure provider and Yard regions resolve to their actual jurisdictions", () => {
	const regions = new Set([
		...createAzureProvider().regions,
		...azureYardRuntimeRegistration().supportedCatalog.regions,
	]);
	const expected = new Map([
		["eastus", ["us"]],
		["eastus2", ["us"]],
		["westus2", ["us"]],
		["westeurope", ["eu", "eea"]],
	]);
	expect(regions).toEqual(new Set(expected.keys()));
	for (const region of regions) {
		expect(jurisdictionsForRegion(region)).toEqual(expected.get(region));
	}
	const euOnly = parseResidencyConstraint({
		classifications: ["pii"],
		allowedJurisdictions: ["eu"],
	});
	for (const region of regions) {
		expect(evaluateResidency({ constraint: euOnly, region }).ok).toBe(
			region === "westeurope",
		);
	}
});
