import { bindle, collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { createRegistryFromProviders, plan } from "@hobo/cloud";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import { createVercelProvider } from "@hobo/provider-vercel";
import { describe, expect, it } from "vitest";

describe("SDK bucket planning", () => {
	it.each([
		["Cloudflare", createCloudflareProvider(), "@hobo/provider-cloudflare"],
		["Vercel", createVercelProvider(), "@hobo/provider-vercel"],
	] as const)("plans a declared bucket through %s object storage", (_name, provider, providerId) => {
		const app = bindle("artifact-test", (b) => ({
			artifacts: b.bucket().allow("read", "write"),
		}));
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(app),
		).manifest;
		const result = plan(
			manifest,
			{ deploymentId: "artifact-test" },
			createRegistryFromProviders([provider]),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.plan.resources[0]).toMatchObject({
			name: "artifacts",
			port: "objectStore",
			provider: providerId,
		});
	});
});
