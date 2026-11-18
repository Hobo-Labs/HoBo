import {
	evaluateResidency,
	jurisdictionsForRegion,
	parseResidencyConstraint,
} from "@hobo/core";
import { expect, test } from "vitest";

import { createCloudflareProvider } from "../src/provider.js";
import {
	CLOUDFLARE_R2_RESIDENCY_REGIONS,
	cloudflareR2ResidencyEvidence,
} from "../src/residency.js";

test("Cloudflare placement labels do not establish a jurisdiction", () => {
	const constraint = parseResidencyConstraint({
		classifications: ["pii"],
		allowedJurisdictions: ["eu"],
	});
	const regions = createCloudflareProvider({
		colos: ["WNAM", "ENAM", "WEUR"],
	}).regions;
	expect(regions.length).toBeGreaterThan(0);
	for (const region of regions) {
		const result = evaluateResidency({ constraint, region });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("region-unmapped");
	}
});

test("R2 jurisdiction controls produce verified placement evidence", () => {
	const eu = cloudflareR2ResidencyEvidence("eu");
	expect(eu).toMatchObject({
		providerId: "cloudflare",
		productId: "cloudflare.r2/v1",
		control: "cf-r2-jurisdiction",
		region: CLOUDFLARE_R2_RESIDENCY_REGIONS.eu,
		jurisdictions: ["eu", "eea"],
		verified: true,
		verification: {
			method: "successful-scoped-api-request",
			header: "cf-r2-jurisdiction",
			value: "eu",
		},
	});
	expect(jurisdictionsForRegion(eu.region)).toEqual(["eu", "eea"]);

	const constraint = parseResidencyConstraint({
		classifications: ["pii"],
		allowedJurisdictions: ["eu"],
	});
	expect(evaluateResidency({ constraint, region: eu.region }).ok).toBe(true);
	expect(
		evaluateResidency({
			constraint,
			region: cloudflareR2ResidencyEvidence("fedramp").region,
		}).ok,
	).toBe(false);
	expect(() => cloudflareR2ResidencyEvidence("us")).toThrow(
		/Unsupported Cloudflare R2 jurisdiction/u,
	);
});
