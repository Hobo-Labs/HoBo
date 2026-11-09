import { describe, expect, it } from "vitest";
import {
	createNetlifyProvider,
	netlifyNativePorts,
	supportsAnonymousTemporaryDeploy,
} from "../src/index.js";
import {
	parseNetlifyAnonymousDeployOutput,
	provisionTemporaryEnvironmentStation,
} from "../src/temporary-station.js";

describe("@hobo/provider-netlify", () => {
	it("exposes Matching-honest native ports", () => {
		const provider = createNetlifyProvider();
		expect(netlifyNativePorts().length).toBeGreaterThan(0);
		expect(provider.capabilities.length).toBe(netlifyNativePorts().length);
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(compute?.satisfies({ port: "compute" }).kind).toBe("full");
	});

	it("temporary deploy support flag is honest", () => {
		expect(supportsAnonymousTemporaryDeploy).toBe(true);
	});

	it("parses anonymous deploy JSON and refuses invented URL fallback", () => {
		const pretty = `{
  "site_id": "site_abc",
  "site_url": "http://radiant-fox-123.netlify.app",
  "deploy_id": "dep_abc",
  "claim_url": "https://app.netlify.com/drop/radiant-fox-123#drop_token=x",
  "password": "My-Drop-Site"
}`;
		const fromCli = parseNetlifyAnonymousDeployOutput(pretty);
		expect(fromCli.stationUrl).toBe("https://radiant-fox-123.netlify.app");
		expect(fromCli.claimUrl).toContain("drop_token=x");
		expect(fromCli.claimUrl).toContain("password=My-Drop-Site");
		expect(fromCli.deployId).toBe("dep_abc");

		expect(() =>
			parseNetlifyAnonymousDeployOutput(
				"Website URL: https://cool-site.netlify.app\nDone",
			),
		).toThrow(/claim URL/);
	});

	it("temporary provision path", async () => {
		const result = await provisionTemporaryEnvironmentStation({
			stationId: "st-1",
			transport: {
				async deployAnonymous() {
					return {
						deployId: "d1",
						stationUrl: "https://d1.netlify.app",
						claimUrl: "https://app.netlify.com/claim/d1",
					};
				},
			},
		});
		expect(result.anonymous).toBe(true);
		expect(result.providerId).toBe("netlify");
		expect(result.stationUrl).toContain("netlify.app");
	});
});
