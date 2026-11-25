import {
	createMeteringBus,
	MessagingDeliveryExhaustedError,
	type MeteringBus,
	parseConsumerGroupId,
	parseSubscriptionName,
	parseTenantId,
	parseTopicName,
	type UsageEvent,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createDaprMessaging,
	createInMemoryDaprClient,
	defaultDaprRuntimeConfig,
	MessagingDeliveryError,
} from "../src/index.js";

const CONFIG = defaultDaprRuntimeConfig("acme", "prod");

function busFor(options: { metering?: MeteringBus } = {}) {
	const base = {
		config: CONFIG,
		client: createInMemoryDaprClient(),
	};
	if (options.metering)
		return createDaprMessaging({ ...base, metering: options.metering });
	return createDaprMessaging(base);
}

async function publish(
	bus: ReturnType<typeof busFor>,
	count: number,
	topic = "events",
) {
	for (let index = 0; index < count; index += 1) {
		await bus.publish(topic as never, { index });
	}
}

describe("a handler that succeeds", () => {
	it("acks each message it handled", async () => {
		const bus = busFor();
		await publish(bus, 2);
		const result = await bus.subscribe(
			"events" as never,
			"g1" as never,
			async () => undefined,
		);
		expect(result).toMatchObject({ handled: 2, deadLettered: 0 });
	});

	it("does not redeliver an acked message", async () => {
		const bus = busFor();
		await publish(bus, 1);
		await bus.subscribe(
			"events" as never,
			"g1" as never,
			async () => undefined,
		);
		const again = await bus.consume("events" as never, "g1" as never);
		expect(again).toHaveLength(0);
	});

	it("handles nothing when there is nothing to handle", async () => {
		const bus = busFor();
		expect(
			await bus.subscribe(
				"events" as never,
				"g1" as never,
				async () => undefined,
			),
		).toMatchObject({ handled: 0, deadLettered: 0 });
	});

	it("records an ack on the event log", async () => {
		const bus = busFor();
		await publish(bus, 1);
		await bus.subscribe(
			"events" as never,
			"g1" as never,
			async () => undefined,
		);
		expect(bus.events().map((event) => event.type)).toContain(
			"messaging.acked",
		);
	});
});

describe("a handler that throws", () => {
	it("does not count the message as handled", async () => {
		const bus = busFor();
		await publish(bus, 1);
		const result = await bus.subscribe(
			"events" as never,
			"g1" as never,
			async () => {
				throw new Error("downstream timeout");
			},
		);
		expect(result.handled).toBe(0);
	});

	it("keeps delivering the rest of the batch", async () => {
		const bus = busFor();
		await publish(bus, 3);
		const seen: number[] = [];
		await bus.subscribe("events" as never, "g1" as never, async (message) => {
			const body = message.body as { index: number };
			seen.push(body.index);
			if (body.index === 0) throw new Error("poison");
		});
		expect(seen).toHaveLength(3);
	});

	it("leaves the message available for another attempt", async () => {
		const bus = busFor();
		await publish(bus, 1);
		await bus.subscribe("events" as never, "g1" as never, async () => {
			throw new Error("downstream timeout");
		});
		expect(await bus.consume("events" as never, "g1" as never)).toHaveLength(1);
	});

	it("records the failure on the event log", async () => {
		const bus = busFor();
		await publish(bus, 1);
		await bus.subscribe("events" as never, "g1" as never, async () => {
			throw new Error("downstream timeout");
		});
		expect(bus.events().length).toBeGreaterThan(0);
	});
});

describe("exhausted deliveries", () => {
	async function configuredBus(maxDeliveryAttempts = 2) {
		const bus = busFor();
		await bus.ensureSubscription({
			name: parseSubscriptionName("events-g1"),
			tenantId: parseTenantId("acme"),
			topic: parseTopicName("events"),
			consumerGroup: parseConsumerGroupId("g1"),
			delivery: "at-least-once",
			maxDeliveryAttempts,
		});
		return bus;
	}
	const fail = async () => {
		throw new Error("always fails");
	};

	it("reports exhaustion without acknowledging or claiming a dead letter", async () => {
		const bus = await configuredBus();
		await publish(bus, 1);
		await bus.subscribe(
			parseTopicName("events"),
			parseConsumerGroupId("g1"),
			fail,
		);
		const error = await bus
			.subscribe(parseTopicName("events"), parseConsumerGroupId("g1"), fail)
			.catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(MessagingDeliveryExhaustedError);
		if (!(error instanceof MessagingDeliveryExhaustedError))
			throw new Error("expected exhaustion");
		expect(bus.events().map((event) => event.type)).toContain(
			"messaging.delivery.exhausted",
		);
		expect(bus.events().map((event) => event.type)).not.toContain(
			"messaging.dead_lettered",
		);
		await bus.nack(error.delivery.messageId, error.delivery.leaseId);
		const replay = await bus.consume(
			parseTopicName("events"),
			parseConsumerGroupId("g1"),
		);
		expect(replay[0]?.messageId).toBe(error.delivery.messageId);
	});

	it("exposes the remaining leased messages when a batch stops", async () => {
		const bus = await configuredBus(1);
		await publish(bus, 2);
		const error = await bus
			.subscribe(parseTopicName("events"), parseConsumerGroupId("g1"), fail)
			.catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(MessagingDeliveryExhaustedError);
		if (!(error instanceof MessagingDeliveryExhaustedError))
			throw new Error("expected exhaustion");
		expect(error.handled).toBe(0);
		expect(error.unprocessed).toHaveLength(1);
		expect(error.unprocessed[0]?.messageId).not.toBe(error.delivery.messageId);
	});

	it("allows attempts below the configured maximum", async () => {
		const bus = await configuredBus(10);
		await publish(bus, 1);
		expect(
			await bus.subscribe(
				parseTopicName("events"),
				parseConsumerGroupId("g1"),
				fail,
			),
		).toEqual({ handled: 0, deadLettered: 0 });
		expect(
			await bus.subscribe(
				parseTopicName("events"),
				parseConsumerGroupId("g1"),
				fail,
			),
		).toEqual({ handled: 0, deadLettered: 0 });
	});
});

describe("acking a message the consumer does not hold", () => {
	it("refuses an unknown message id", async () => {
		const bus = busFor();
		await expect(
			bus.ack("no-such-message" as never, "no-such-lease" as never),
		).rejects.toThrow(MessagingDeliveryError);
	});

	it("refuses a nack for an unknown message id", async () => {
		const bus = busFor();
		await expect(
			bus.nack("no-such-message" as never, "no-such-lease" as never, "why"),
		).rejects.toThrow(MessagingDeliveryError);
	});

	it("names the message it could not find", async () => {
		const bus = busFor();
		await expect(
			bus.ack("no-such-message" as never, "no-such-lease" as never),
		).rejects.toThrow(/no-such-message/);
	});

	it("refuses a second ack for a message already acked", async () => {
		const bus = busFor();
		await publish(bus, 1);
		const batch = await bus.consume("events" as never, "g1" as never);
		const message = batch[0];
		if (!message) throw new Error("expected a message");
		await bus.ack(message.messageId, message.leaseId);
		await expect(bus.ack(message.messageId, message.leaseId)).rejects.toThrow(
			MessagingDeliveryError,
		);
	});
});

describe("metering", () => {
	it("reports messages published", async () => {
		const emitted: UsageEvent[] = [];
		const bus = busFor({
			metering: createMeteringBus([
				{
					sinkId: "capture",
					emit: (event) => {
						emitted.push(event);
					},
				},
			]),
		});
		await publish(bus, 1);
		expect(emitted.map((event) => event.eventType)).toContain(
			"messaging.publish",
		);
	});

	it("reports nothing for a consume that returned no messages", async () => {
		const emitted: UsageEvent[] = [];
		const bus = busFor({
			metering: createMeteringBus([
				{
					sinkId: "capture",
					emit: (event) => {
						emitted.push(event);
					},
				},
			]),
		});
		await bus.consume("events" as never, "g1" as never);
		expect(emitted).toStrictEqual([]);
	});

	it("publishes without a meter wired", async () => {
		const bus = busFor();
		await expect(publish(bus, 1)).resolves.toBeUndefined();
	});
});
