import {
	MessagingDeliveryExhaustedError,
	parseConsumerGroupId,
	parseTopicName,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createDaprMessaging,
	createInMemoryDaprClient,
	defaultDaprRuntimeConfig,
} from "../src/index.js";

describe("dapr live exhausted delivery", () => {
	it("retains the delivery after max attempts", async () => {
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

		const error = await bus
			.subscribe(
				parseTopicName("fail"),
				parseConsumerGroupId("workers"),
				async () => {
					throw new Error("boom");
				},
			)
			.catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(MessagingDeliveryExhaustedError);
		if (!(error instanceof MessagingDeliveryExhaustedError))
			throw new Error("expected exhaustion");
		expect(bus.capabilities.deadLetter).toBe(false);
		expect(bus.events().map((event) => event.type)).toContain(
			"messaging.delivery.exhausted",
		);
		expect(bus.events().map((event) => event.type)).not.toContain(
			"messaging.dead_lettered",
		);
		await bus.nack(error.delivery.messageId, error.delivery.leaseId);
		const replay = await bus.consume(
			parseTopicName("fail"),
			parseConsumerGroupId("workers"),
		);
		expect(replay[0]?.messageId).toBe(error.delivery.messageId);
	});
});
