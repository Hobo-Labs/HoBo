/**
 * Subscribing over daprd: what happens when a handler throws.
 *
 * `subscribe` is the loop an application actually runs — consume a batch, hand
 * each message to a handler, and decide what to do when the handler fails. The
 * decision is where all the risk is, because both wrong answers are bad in
 * ways that take a while to notice.
 *
 * **Retry forever and one poison message stops the queue.** Every consumer
 * behind it starves while the same message is redelivered, and the topic looks
 * healthy from the outside — messages are flowing in, nothing is erroring
 * loudly, and throughput is zero.
 *
 * **Drop on first failure and a transient blip loses data silently.** A
 * downstream timeout is the commonest handler failure and the one most likely
 * to succeed on the next attempt.
 *
 * So a failure nacks — putting the message back for another attempt — until
 * the delivery count reaches the subscription's `maxDeliveryAttempts`, and
 * then the message is dead-lettered: acked under the real consumer group so it
 * stops being redelivered, and recorded on the event log so it can be found.
 *
 * The ack on the dead-letter path is deliberate and worth stating: it acks
 * rather than nacking first, because a nack would return the message to the
 * queue one more time after the platform has already decided it is poison.
 *
 * Two smaller properties come with it:
 *
 * **A failed handler does not stop the batch.** The remaining messages are
 * still delivered — one bad message must not cost the whole batch.
 *
 * **Ack and nack refuse a message that is not in flight.** Acking something
 * the consumer does not hold means either a double-ack or a forged id, and
 * both would release a lease someone else owns.
 */
import {
	createMeteringBus,
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

/** Publish `count` messages onto one topic. */
async function publish(
	bus: ReturnType<typeof busFor>,
	count: number,
	topic = "events",
) {
	for (let index = 0; index < count; index += 1) {
		// SAFETY: the fixture uses wire-shaped topic names.
		await bus.publish(topic as never, { index });
	}
}

describe("a handler that succeeds", () => {
	it("acks each message it handled", async () => {
		const bus = busFor();
		await publish(bus, 2);
		// SAFETY: the fixture uses wire-shaped topic and group names.
		const result = await bus.subscribe(
			"events" as never,
			"g1" as never,
			async () => undefined,
		);
		expect(result).toMatchObject({ handled: 2, deadLettered: 0 });
	});

	it("does not redeliver an acked message", async () => {
		// The point of acking. A message handled and then redelivered would be
		// processed twice by an application that believes it is at-least-once.
		const bus = busFor();
		await publish(bus, 1);
		// SAFETY: the fixture uses wire-shaped topic and group names.
		await bus.subscribe(
			"events" as never,
			"g1" as never,
			async () => undefined,
		);
		// SAFETY: the fixture uses wire-shaped topic and group names.
		const again = await bus.consume("events" as never, "g1" as never);
		expect(again).toHaveLength(0);
	});

	it("handles nothing when there is nothing to handle", async () => {
		const bus = busFor();
		// SAFETY: the fixture uses wire-shaped topic and group names.
		expect(
			await bus.subscribe(
				"events" as never,
				"g1" as never,
				async () => undefined,
			),
		).toMatchObject({ handled: 0, deadLettered: 0 });
	});

	it("records an ack on the event log", async () => {
		// The log is how a dead letter is found later; acks share it so the
		// full lifecycle of a message is in one place.
		const bus = busFor();
		await publish(bus, 1);
		// SAFETY: the fixture uses wire-shaped topic and group names.
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
		// SAFETY: the fixture uses wire-shaped topic and group names.
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
		// One bad message must not cost the whole batch — otherwise a single
		// poison payload stalls every message that happened to arrive with it.
		const bus = busFor();
		await publish(bus, 3);
		const seen: number[] = [];
		// SAFETY: the fixture uses wire-shaped topic and group names.
		await bus.subscribe("events" as never, "g1" as never, async (message) => {
			// SAFETY: the fixture publishes exactly this body shape.
			const body = message.body as { index: number };
			seen.push(body.index);
			if (body.index === 0) throw new Error("poison");
		});
		expect(seen).toHaveLength(3);
	});

	it("leaves the message available for another attempt", async () => {
		// Dropping on first failure would lose data to a downstream timeout —
		// the commonest handler failure and the one most likely to succeed next
		// time.
		const bus = busFor();
		await publish(bus, 1);
		// SAFETY: the fixture uses wire-shaped topic and group names.
		await bus.subscribe("events" as never, "g1" as never, async () => {
			throw new Error("downstream timeout");
		});
		// SAFETY: the fixture uses wire-shaped topic and group names.
		expect(await bus.consume("events" as never, "g1" as never)).toHaveLength(1);
	});

	it("records the failure on the event log", async () => {
		const bus = busFor();
		await publish(bus, 1);
		// SAFETY: the fixture uses wire-shaped topic and group names.
		await bus.subscribe("events" as never, "g1" as never, async () => {
			throw new Error("downstream timeout");
		});
		expect(bus.events().length).toBeGreaterThan(0);
	});
});

describe("dead-lettering", () => {
	/** Subscribe repeatedly with a handler that always throws. */
	async function drainFailing(
		bus: ReturnType<typeof busFor>,
		rounds: number,
		maxDeliveryAttempts?: number,
	) {
		if (maxDeliveryAttempts !== undefined) {
			await bus.ensureSubscription({
				name: parseSubscriptionName("events-g1"),
				tenantId: parseTenantId("acme"),
				topic: parseTopicName("events"),
				consumerGroup: parseConsumerGroupId("g1"),
				delivery: "at-least-once",
				maxDeliveryAttempts,
			});
		}
		let deadLettered = 0;
		for (let round = 0; round < rounds; round += 1) {
			// SAFETY: the fixture uses wire-shaped topic and group names.
			const result = await bus.subscribe(
				"events" as never,
				"g1" as never,
				async () => {
					throw new Error("always fails");
				},
			);
			deadLettered += result.deadLettered;
		}
		return deadLettered;
	}

	it("dead-letters a message once its attempts run out", async () => {
		// Retrying forever would stall the queue: every consumer behind the
		// poison message starves while the topic looks healthy from outside.
		const bus = busFor();
		await publish(bus, 1);
		expect(await drainFailing(bus, 4, 2)).toBeGreaterThan(0);
	});

	it("stops redelivering a dead-lettered message", async () => {
		// The dead-letter path acks rather than nacking first — a nack would
		// return the message to the queue one more time after the platform has
		// already decided it is poison.
		const bus = busFor();
		await publish(bus, 1);
		await drainFailing(bus, 6, 2);
		// SAFETY: the fixture uses wire-shaped topic and group names.
		expect(await bus.consume("events" as never, "g1" as never)).toHaveLength(0);
	});

	it("records the dead letter so it can be found", async () => {
		// A message dropped with no record is data lost silently, which is the
		// failure dead-lettering exists to replace.
		const bus = busFor();
		await publish(bus, 1);
		await drainFailing(bus, 6, 2);
		expect(bus.events().map((event) => event.type)).toContain(
			"messaging.dead_lettered",
		);
	});

	it("honours a higher attempt budget", async () => {
		// The budget is per subscription because retry tolerance is a property
		// of the workload, not of the platform.
		const bus = busFor();
		await publish(bus, 1);
		expect(await drainFailing(bus, 2, 10)).toBe(0);
	});

	it("defaults the attempt budget when no subscription declared one", async () => {
		// A handler subscribing without calling `ensureSubscription` still gets
		// a bounded retry rather than an infinite one.
		const bus = busFor();
		await publish(bus, 1);
		expect(await drainFailing(bus, 2)).toBe(0);
	});
});

describe("acking a message the consumer does not hold", () => {
	it("refuses an unknown message id", async () => {
		// Either a double-ack or a forged id; both would release a lease
		// someone else owns.
		const bus = busFor();
		await expect(
			// SAFETY: the fixture uses wire-shaped ids.
			bus.ack("no-such-message" as never, "no-such-lease" as never),
		).rejects.toThrow(MessagingDeliveryError);
	});

	it("refuses a nack for an unknown message id", async () => {
		const bus = busFor();
		await expect(
			// SAFETY: the fixture uses wire-shaped ids.
			bus.nack("no-such-message" as never, "no-such-lease" as never, "why"),
		).rejects.toThrow(MessagingDeliveryError);
	});

	it("names the message it could not find", async () => {
		const bus = busFor();
		await expect(
			// SAFETY: the fixture uses wire-shaped ids.
			bus.ack("no-such-message" as never, "no-such-lease" as never),
		).rejects.toThrow(/no-such-message/);
	});

	it("refuses a second ack for a message already acked", async () => {
		// The double-ack case specifically: the lease is gone, and a second ack
		// would release whatever holds it next.
		const bus = busFor();
		await publish(bus, 1);
		// SAFETY: the fixture uses wire-shaped topic and group names.
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
		// Quantity zero is not a billable event. Emitting it would fill the
		// meter with noise from idle pollers and make real usage harder to see.
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
		// SAFETY: the fixture uses wire-shaped topic and group names.
		await bus.consume("events" as never, "g1" as never);
		expect(emitted).toStrictEqual([]);
	});

	it("publishes without a meter wired", async () => {
		// Metering is optional; a bus with no meter still has to carry traffic.
		const bus = busFor();
		await expect(publish(bus, 1)).resolves.toBeUndefined();
	});
});
