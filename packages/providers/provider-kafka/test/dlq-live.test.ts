import {
	MessagingDeliveryExhaustedError,
	parseConsumerGroupId,
	parseSubscriptionName,
	parseTenantId,
	parseTopicName,
} from "@hobo/core";
import { describe, expect, it, vi } from "vitest";

import {
	createInMemoryKafkaTransport,
	createKafkaMessaging,
	localRedpandaCluster,
} from "../src/index.js";

describe("kafka live exhausted delivery", () => {
	it("rejects dead-letter configuration before contacting the transport", async () => {
		const inner = createInMemoryKafkaTransport();
		const ensureTopic = vi.fn(inner.ensureTopic);
		const transport = { ...inner, ensureTopic };
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("acme"),
			transport,
		});
		await expect(
			bus.ensureSubscription({
				name: parseSubscriptionName("s"),
				topic: parseTopicName("orders"),
				consumerGroup: parseConsumerGroupId("g"),
				tenantId: parseTenantId("acme"),
				delivery: "at-least-once",
				maxDeliveryAttempts: 2,
				deadLetterTopic: parseTopicName("dead"),
			}),
		).rejects.toMatchObject({ code: "MESSAGING_CAPABILITY" });
		expect(ensureTopic).not.toHaveBeenCalled();
	});

	it("retains the delivery after max attempts", async () => {
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("acme"),
			transport: createInMemoryKafkaTransport(),
		});
		await bus.ensureSubscription({
			name: parseSubscriptionName("s"),
			topic: parseTopicName("fail"),
			consumerGroup: parseConsumerGroupId("g"),
			tenantId: parseTenantId("acme"),
			delivery: "at-least-once",
			maxDeliveryAttempts: 2,
		});
		await bus.publish(parseTopicName("fail"), { x: 1 });

		const r1 = await bus.subscribe(
			parseTopicName("fail"),
			parseConsumerGroupId("g"),
			async () => {
				throw new Error("boom");
			},
		);
		expect(r1.handled).toBe(0);
		expect(r1.deadLettered).toBe(0);

		const error = await bus
			.subscribe(
				parseTopicName("fail"),
				parseConsumerGroupId("g"),
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
			parseConsumerGroupId("g"),
		);
		expect(replay[0]?.messageId).toBe(error.delivery.messageId);
	});
});
