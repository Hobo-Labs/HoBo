import { stableDigest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	AGENT37_COST_FACTS,
	AGENT37_PROVIDER_ID,
	publishCapabilityManifest,
} from "../src/index.js";

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
const index = JSON.parse(
	documents["/.well-known/capability-manifest/index.json"],
);

describe("Agent37 capability manifest", () => {
	it("declares the CI runner capability and regions", () => {
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

	it("declares honest full-workspace static key authentication", () => {
		expect(auth).toMatchObject({
			mode: "static-api-key",
			staticSecrets: true,
			scopes: "workspace-full",
			rotation: "manual-dashboard",
			oidc: false,
			oauth: false,
			keyPage: "https://www.agent37.com/dashboard/cloud/api-keys",
		});
		expect(auth).not.toHaveProperty("staticKey");
		expect(auth).not.toHaveProperty("clientSecret");
	});

	it("publishes dated estimated per-minute cost facts", () => {
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
				sku: "agent37.vm.2vcpu-4gb.instance-minute",
				marginalPrice: ((4.76 * 2.5) / 730 / 60).toFixed(12),
			}),
		);
	});

	it("indexes unique documents by the digest of what it published", () => {
		expect(index.manifestSchema).toBe("hobo.capability-manifest/v1");
		expect(index.documents).toHaveLength(3);
		const paths = index.documents.map((document) => document.path);
		expect(new Set(paths).size).toBe(paths.length);
		for (const document of index.documents) {
			expect(document.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
			if (document.path === "/.well-known/capability-manifest/capabilities.json")
				expect(document.digest).toBe(stableDigest(capabilities));
			else if (document.path === "/.well-known/capability-manifest/auth.json")
				expect(document.digest).toBe(stableDigest(auth));
			else if (document.path === "/.well-known/capability-manifest/cost.json")
				expect(document.digest).toBe(stableDigest(cost));
			else throw new Error(`unexpected manifest document: ${document.path}`);
		}
	});
});
