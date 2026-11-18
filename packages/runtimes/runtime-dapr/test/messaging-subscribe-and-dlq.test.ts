import { MESSAGING_EVENTS, type UsageEvent } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createDaprMessaging,
	createInMemoryDaprClient,
	defaultDaprRuntimeConfig,
	type DaprMessagingOptions,
	MessagingDeliveryError,
} from "../src/index.js";

const CONFIG = defaultDaprRuntimeConfig("acme", "prod");

function busFor(options: Pick<DaprMessagingOptions, "metering"> = {}) {
	return createDaprMessaging({
		config: CONFIG,
		client: createInMemoryDaprClient(),
		...options,
	});
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
		await bus.flush?.();
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
			MESSAGING_EVENTS.MessageAcknowledged,
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
		await bus.flush?.();
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

describe("dead-lettering", () => {
	async function drainFailing(
		bus: ReturnType<typeof busFor>,
		rounds: number,
		maxDeliveryAttempts?: number,
	) {
		if (maxDeliveryAttempts !== undefined) {
			await bus.ensureSubscription({
				tenantId: "acme",
				topic: "events",
				consumerGroup: "g1",
				maxDeliveryAttempts,
			} as never);
		}
		let deadLettered = 0;
		for (let round = 0; round < rounds; round += 1) {
			const result = await bus.subscribe(
				"events" as never,
				"g1" as never,
				async () => {
					throw new Error("always fails");
				},
			);
			deadLettered += result.deadLettered;
			await bus.flush?.();
		}
		return deadLettered;
	}

	it("dead-letters a message once its attempts run out", async () => {
		const bus = busFor();
		await publish(bus, 1);
		expect(await drainFailing(bus, 4, 2)).toBeGreaterThan(0);
	});

	it("stops redelivering a dead-lettered message", async () => {
		const bus = busFor();
		await publish(bus, 1);
		await drainFailing(bus, 6, 2);
		expect(await bus.consume("events" as never, "g1" as never)).toHaveLength(0);
	});

	it("records the dead letter so it can be found", async () => {
		const bus = busFor();
		await publish(bus, 1);
		await drainFailing(bus, 6, 2);
		expect(bus.events().map((event) => event.type)).toContain(
			MESSAGING_EVENTS.MessageDeadLettered,
		);
	});

	it("honours a higher attempt budget", async () => {
		const bus = busFor();
		await publish(bus, 1);
		expect(await drainFailing(bus, 2, 10)).toBe(0);
	});

	it("defaults the attempt budget when no subscription declared one", async () => {
		const bus = busFor();
		await publish(bus, 1);
		expect(await drainFailing(bus, 2)).toBe(0);
	});
});

describe("acking a message the consumer does not hold", () => {
	it("refuses an unknown message id", async () => {
		const bus = busFor();
		expect(() =>
			bus.ack("no-such-message" as never, "no-such-lease" as never),
		).toThrow(MessagingDeliveryError);
	});

	it("refuses a nack for an unknown message id", () => {
		const bus = busFor();
		expect(() =>
			bus.nack("no-such-message" as never, "no-such-lease" as never, "why"),
		).toThrow(MessagingDeliveryError);
	});

	it("names the message it could not find", () => {
		const bus = busFor();
		expect(() =>
			bus.ack("no-such-message" as never, "no-such-lease" as never),
		).toThrow(/no-such-message/);
	});

	it("refuses a second ack for a message already acked", async () => {
		const bus = busFor();
		await publish(bus, 1);
		const batch = await bus.consume("events" as never, "g1" as never);
		const message = batch[0];
		if (!message) throw new Error("expected a message");
		bus.ack(message.messageId, message.leaseId);
		await bus.flush?.();
		expect(() => bus.ack(message.messageId, message.leaseId)).toThrow(
			MessagingDeliveryError,
		);
	});
});

describe("metering", () => {
	it("reports messages published", async () => {
		const emitted: UsageEvent[] = [];
		const bus = busFor({
			metering: {
				emit: (event) => {
					emitted.push(event);
				},
			},
		});
		await publish(bus, 1);
		expect(emitted.map((event) => event.eventType)).toContain(
			"messaging.publish",
		);
	});

	it("reports nothing for a consume that returned no messages", async () => {
		const emitted: UsageEvent[] = [];
		const bus = busFor({
			metering: {
				emit: (event) => {
					emitted.push(event);
				},
			},
		});
		await bus.consume("events" as never, "g1" as never);
		expect(emitted).toStrictEqual([]);
	});

	it("publishes without a meter wired", async () => {
		const bus = busFor();
		await expect(publish(bus, 1)).resolves.toBeUndefined();
	});
});
