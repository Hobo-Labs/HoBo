import { bindle, collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { createRegistryFromProviders, plan } from "@hobo/cloud";
import { createAwsProvider } from "@hobo/provider-aws";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import { createGcpProvider } from "@hobo/provider-gcp";
import { describe, expect, it } from "vitest";

describe("SDK key-value planning", () => {
	it.each([
		["AWS", createAwsProvider(), "@hobo/provider-aws"],
		["Cloudflare", createCloudflareProvider(), "@hobo/provider-cloudflare"],
		["GCP", createGcpProvider(), "@hobo/provider-gcp"],
	] as const)("plans an unconstrained key-value declaration using %s", (_name, provider, providerId) => {
		const app = bindle("kv-test", (b) => ({
			cache: b.kv().allow("get", "set"),
		}));
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(app),
		).manifest;
		const result = plan(
			manifest,
			{ deploymentId: "kv-test" },
			createRegistryFromProviders([provider]),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.plan.resources[0]).toMatchObject({
			name: "cache",
			port: "kv",
			provider: providerId,
		});
	});
});
