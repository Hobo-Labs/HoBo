import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory } from "@hobo/contract-harness";
import { parseRoutingPlan } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createCloudflareTrafficRouting } from "../../src/index.js";
import { createPactFetch } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("CloudflareLoadBalancingApi consumer contract", () => {
	it("applies, observes, and revokes routing through the Pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find(
			({ provider }) => provider.name === "CloudflareLoadBalancingApi",
		);
		expect(pact).toBeDefined();
		if (!pact) throw new Error("Cloudflare TrafficRouting Pact is missing");

		const plan = parseRoutingPlan({
			planId: "plan:checkout:pact",
			intent: {
				service: "checkout.example.test",
				tenantId: "tenant-a",
				rules: [
					{
						backends: [
							{
								id: "backend:primary",
								service: "checkout",
								weight: 100,
								endpoint: "https://checkout.example.test",
							},
						],
						weightStrategy: "static",
					},
				],
			},
			backends: [
				{
					id: "backend:primary",
					service: "checkout",
					weight: 100,
					endpoint: "https://checkout.example.test",
				},
			],
			createdAt: "2026-08-03T15:00:00.000Z",
		});
		const routing = createCloudflareTrafficRouting({
			apiToken: "test-token",
			zoneId: "zone-a",
			loadBalancerIdsByPlan: {
				"plan:checkout:pact": "load-balancer-a",
			},
			poolIdsByBackend: { "backend:primary": "pool-primary" },
			fetchImpl: createPactFetch(pact),
		});

		await expect(routing.apply(plan)).resolves.toMatchObject({
			provider: "cloudflare",
			realized: "full",
			appliedRules: 1,
		});
		await expect(routing.status(plan.planId)).resolves.toMatchObject({
			active: true,
			realized: "full",
		});
		await expect(routing.revoke(plan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
	});

	it("creates pool and load balancer through the Pact mock when unmapped", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find(
			({ provider }) => provider.name === "CloudflareLoadBalancingApi",
		);
		expect(pact).toBeDefined();
		if (!pact) throw new Error("Cloudflare TrafficRouting Pact is missing");

		const plan = parseRoutingPlan({
			planId: "plan:checkout:create",
			intent: {
				service: "checkout.example.test",
				tenantId: "tenant-a",
				rules: [
					{
						backends: [
							{
								id: "backend:primary",
								service: "checkout",
								weight: 100,
								endpoint: "https://checkout.example.test",
							},
						],
						weightStrategy: "static",
					},
				],
			},
			backends: [
				{
					id: "backend:primary",
					service: "checkout",
					weight: 100,
					endpoint: "https://checkout.example.test",
				},
			],
			createdAt: "2026-08-03T15:00:00.000Z",
		});
		const routing = createCloudflareTrafficRouting({
			apiToken: "test-token",
			zoneId: "zone-a",
			accountId: "account-a",
			fetchImpl: createPactFetch(pact),
		});

		await expect(routing.apply(plan)).resolves.toMatchObject({
			provider: "cloudflare",
			realized: "full",
			appliedRules: 1,
		});
		const health = await routing.observeHealth(plan.planId);
		expect(health).toEqual([
			expect.objectContaining({
				backendId: "backend:primary",
				healthy: true,
				poolId: "pool-created-primary",
			}),
		]);
		await expect(routing.revoke(plan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
	});
});
