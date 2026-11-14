import { bindle, collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { createRegistryFromProviders, plan } from "@hobo/cloud";
import { createAwsProvider } from "@hobo/provider-aws";
import { createGcpProvider } from "@hobo/provider-gcp";
import { createVercelProvider } from "@hobo/provider-vercel";
import { describe, expect, it } from "vitest";

describe("SDK queue planning", () => {
	const app = bindle("queue-test", (b) => ({
		jobs: b.queue().allow("enqueue", "dequeue"),
	}));
	const manifest = collectBindleManifest(
		targetFromBindleDefinition(app),
	).manifest;
	it.each([
		["AWS", createAwsProvider(), "@hobo/provider-aws"],
		["GCP", createGcpProvider(), "@hobo/provider-gcp"],
	] as const)("plans a queue using %s's queue definition", (_name, provider, providerId) => {
		const result = plan(
			manifest,
			{ deploymentId: "queue-test" },
			createRegistryFromProviders([provider]),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.plan.resources[0]).toMatchObject({
			name: "jobs",
			port: "queue",
			provider: providerId,
		});
	});
	it("does not treat a key-value or object-storage provider as a queue", () => {
		const result = plan(
			manifest,
			{ deploymentId: "queue-test" },
			createRegistryFromProviders([createVercelProvider()]),
		);
		expect(result.ok).toBe(false);
	});
});
