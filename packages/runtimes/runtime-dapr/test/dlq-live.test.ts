import { MESSAGING_EVENTS } from "@hobo/core";
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
			// SAFETY: assertion required at this I/O or test boundary.
			name: "s" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			topic: "fail" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			consumerGroup: "workers" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			tenantId: "acme" as never,
			delivery: "at-least-once",
			maxDeliveryAttempts: 2,
		});
		// SAFETY: assertion required at this I/O or test boundary.
		await bus.publish("fail" as never, { x: 1 });

		const r1 = await bus.subscribe(
			// SAFETY: assertion required at this I/O or test boundary.
			"fail" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			"workers" as never,
			async () => {
				throw new Error("boom");
			},
		);
		expect(r1.deadLettered).toBe(0);

		const r2 = await bus.subscribe(
			// SAFETY: assertion required at this I/O or test boundary.
			"fail" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			"workers" as never,
			async () => {
				throw new Error("boom");
			},
		);
		expect(r2.deadLettered).toBe(1);

		// SAFETY: assertion required at this I/O or test boundary.
		const again = await bus.consume("fail" as never, "workers" as never);
		expect(again).toHaveLength(0);

		const types = bus.events().map((e) => e.type);
		expect(types).toContain(MESSAGING_EVENTS.MessageDeadLettered);
		expect(types).toContain(MESSAGING_EVENTS.DeliveryPermanentlyFailed);
	});
});
