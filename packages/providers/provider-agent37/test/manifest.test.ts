import { describe, expect, it } from "vitest";
import {
	AGENT37_COST_FACTS,
	AGENT37_PROVIDER_ID,
	publishCapabilityManifest,
} from "../src/index.js";

describe("Agent37 capability manifest", () => {
	const documents = publishCapabilityManifest();
	const capabilities = JSON.parse(
		documents["/.well-known/capability-manifest/capabilities.json"],
	);
	const auth = JSON.parse(
		documents["/.well-known/capability-manifest/auth.json"],
	);
	const cost = JSON.parse(
		documents["/.well-known/capability-manifest/cost.json"],
	);

	it("declares the CI runner capability", () => {
		expect(capabilities).toMatchObject({
			providerId: AGENT37_PROVIDER_ID,
			capabilities: [
				{
					port: "ci/runner",
					interface: "hobo:runner/job",
					resourceClass: "ci/runner",
					providerService: "agent37",
					regions: ["us", "eu", "ap-south"],
				},
			],
		});
	});

	it("declares only static full-workspace API key authentication", () => {
		expect(auth).toMatchObject({
			mode: "static-api-key",
			staticSecrets: true,
			scopes: "workspace-full",
			rotation: "manual-dashboard",
			oidc: false,
			oauth: false,
			keyPage: "https://www.agent37.com/dashboard/cloud/api-keys",
		});
	});

	it("publishes dated estimated per-minute costs for every supported shape and type", () => {
		expect(cost.facts).toHaveLength(14);
		expect(AGENT37_COST_FACTS).toHaveLength(14);
		expect(cost.facts).not.toContainEqual(
			expect.objectContaining({
				sku: "agent37.default.8vcpu-64gb.instance-minute",
			}),
		);
		for (const fact of cost.facts) {
			expect(fact).toMatchObject({
				port: "ci/runner",
				unit: "instance-minute",
				pricingStatus: "estimate",
				source: {
					type: "declared-provider",
					sourceUrl: "https://www.agent37.com/docs/agents-api/instance-sizing",
					transcribedOn: "2026-11-20",
				},
			});
			expect(Number(fact.marginalPrice)).toBeGreaterThan(0);
		}
		expect(cost.facts).toContainEqual(
			expect.objectContaining({
				sku: "agent37.default.2vcpu-4gb.instance-minute",
				marginalPrice: (4.76 / 730 / 60).toFixed(12),
			}),
		);
		expect(cost.facts).toContainEqual(
			expect.objectContaining({
				sku: "agent37.vm.2vcpu-4gb.instance-minute",
				marginalPrice: ((4.76 * 2.5) / 730 / 60).toFixed(12),
			}),
		);
	});
});
