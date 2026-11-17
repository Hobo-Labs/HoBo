import { evaluateResidency, parseResidencyConstraint } from "@hobo/core";
import { expect, test } from "vitest";

import { createCloudflareProvider } from "../src/provider.js";

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
