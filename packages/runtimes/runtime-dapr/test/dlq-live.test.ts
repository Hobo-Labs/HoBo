import { describe, expect, it } from "vitest";

import {
	createDaprMessaging,
	createInMemoryDaprClient,
	defaultDaprRuntimeConfig,
} from "../src/index.js";

describe("dapr live DLQ", () => {
	it("honors maxDeliveryAttempts and acks under consumer group", async () => {
		const bus = createDaprMessaging({
			config: defaultDaprRuntimeConfig("acme", "prod"),
			client: createInMemoryDaprClient(),
		});
		await bus.ensureSubscription({
			name: "s" as never,
			topic: "fail" as never,
			consumerGroup: "workers" as never,
			tenantId: "acme" as never,
			delivery: "at-least-once",
			maxDeliveryAttempts: 2,
		});
		await bus.publish("fail" as never, { x: 1 });

		const r1 = await bus.subscribe(
			"fail" as never,
			"workers" as never,
			async () => {
				throw new Error("boom");
			},
		);
		expect(r1.deadLettered).toBe(0);

		const r2 = await bus.subscribe(
			"fail" as never,
			"workers" as never,
			async () => {
				throw new Error("boom");
			},
		);
		expect(r2.deadLettered).toBe(1);

		const again = await bus.consume("fail" as never, "workers" as never);
		expect(again).toHaveLength(0);

		const types = bus.events().map((e) => e.type);
		expect(types).toContain("messaging.dead_lettered");
		expect(types).toContain("messaging.delivery.permanent_failure");
	});
});
