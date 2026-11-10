import { createMeteringBus, parseRoutingPlan } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createCloudflareTrafficRouting,
	createInMemoryMeteringSink,
	createSimpleTrafficRouting,
} from "../../src/index.js";

function sharedPlan() {
	return parseRoutingPlan({
		planId: "plan:checkout:conformance",
		intent: {
			service: "checkout",
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
			availability: { minHealthyBackends: 1 },
		},
		backends: [
			{
				id: "backend:primary",
				service: "checkout",
				weight: 100,
				endpoint: "https://checkout.example.test",
			},
		],
		stationId: "station:prod",
		railHash: `sha256:${"a".repeat(64)}`,
		createdAt: "2026-08-03T15:00:00.000Z",
	});
}

describe("TrafficRouting public conformance", () => {
	it("applies one parsed plan with structured degradation and denial", async () => {
		const sink = createInMemoryMeteringSink();
		const metering = createMeteringBus([sink]);
		let cloudflareRequests = 0;
		const plan = sharedPlan();

		const simple = await createSimpleTrafficRouting({ metering }).apply(plan);
		const cloudflare = await createCloudflareTrafficRouting({
			zoneId: "zone-a",
			metering,
			fetchImpl: async () => {
				cloudflareRequests += 1;
				throw new Error("missing credentials must fail before provider I/O");
			},
		}).apply(plan);

		expect(simple).toMatchObject({
			planId: plan.planId,
			provider: "simple",
			realized: "partial",
			unmet: ["availability-constraints"],
		});
		expect(cloudflare).toMatchObject({
			planId: plan.planId,
			provider: "cloudflare",
			realized: "none",
			unmet: ["credentials"],
		});
		expect(cloudflareRequests).toBe(0);
		expect(
			sink.events.map(({ eventType, metadata }) => ({
				eventType,
				provider: metadata?.provider,
			})),
		).toEqual([
			{ eventType: "routing.plan.degraded", provider: "simple" },
			{ eventType: "routing.plan.deny", provider: "cloudflare" },
		]);
	});
});
