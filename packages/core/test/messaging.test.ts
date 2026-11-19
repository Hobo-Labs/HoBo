import { describe, expect, it } from "vitest";

import {
	assertDeliverySupported,
	createInMemoryMessaging,
	MESSAGING_WIT_INTERFACE,
	PORTABLE_MESSAGING_CAPABILITIES,
	parseActorPlacementMode,
	parseConsumerGroupId,
	parseDeliveryGuarantee,
	parseMessagingSpec,
	parseTopicName,
	parseTopicSpec,
	tenantScopedTopicName,
} from "../src/ports/messaging.js";
import { first } from "../src/total-access.js";

describe("@hobo/core messaging port", () => {
	it("pins wasi:messaging interface ref", () => {
		expect(MESSAGING_WIT_INTERFACE).toBe("wasi:messaging/messaging@0.2.0");
	});

	it("parses topic + messaging specs", () => {
		const topic = parseTopicSpec({
			name: "orders",
			tenantId: "acme",
			delivery: "at-least-once",
		});
		expect(topic.name).toBe("orders");
		expect(topic.tenantId).toBe("acme");

		const spec = parseMessagingSpec({
			id: "ms-1",
			tenant_id: "acme",
			backend: "native-kafka",
			topics: [{ name: "orders", tenant_id: "acme", delivery: "exactly-once" }],
			subscriptions: [
				{
					name: "orders-worker",
					topic: "orders",
					consumer_group: "workers",
					tenant_id: "acme",
					delivery: "at-least-once",
					max_delivery_attempts: 3,
				},
			],
		});
		expect(spec.backend).toBe("native-kafka");
		expect(spec.subscriptions[0]?.maxDeliveryAttempts).toBe(3);
	});

	it("tenant-scopes topic names", () => {
		expect(tenantScopedTopicName("acme", "orders")).toBe("acme.orders");
		expect(tenantScopedTopicName("acme", "acme.orders")).toBe("acme.orders");
	});

	it("publish/subscribe round-trip with consumer groups", async () => {
		const bus = createInMemoryMessaging({ tenantId: "t1" });
		await bus.ensureTopic({
			// SAFETY: assertion required at this I/O or test boundary.
			name: "events" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			tenantId: "t1" as never,
			delivery: "at-least-once",
		});
		const pub = await bus.publish(
			// SAFETY: assertion required at this I/O or test boundary.
			"events" as never,
			{ hello: "world" },
			{
				idempotencyKey: "k1",
			},
		);
		expect(pub.deduped).toBe(false);
		const dedup = await bus.publish(
			// SAFETY: assertion required at this I/O or test boundary.
			"events" as never,
			{ hello: "world" },
			{
				idempotencyKey: "k1",
			},
		);
		expect(dedup.deduped).toBe(true);

		// SAFETY: assertion required at this I/O or test boundary.
		const consumed = await bus.consume("events" as never, "workers" as never, {
			maxMessages: 10,
		});
		expect(consumed).toHaveLength(1);
		expect(consumed[0]?.body).toEqual({ hello: "world" });
		const acknowledgement = bus.ack(
			first(consumed).messageId,
			first(consumed).leaseId,
		);
		expect(acknowledgement).toBeInstanceOf(Promise);
		await acknowledgement;
		await expect(
			bus.ack(first(consumed).messageId, first(consumed).leaseId),
		).rejects.toThrow(/no inflight message/);

		// SAFETY: assertion required at this I/O or test boundary.
		const again = await bus.consume("events" as never, "workers" as never);
		expect(again).toHaveLength(0);

		const types = bus.events().map((e) => e.type);
		expect(types).toContain("messaging.topic.created");
		expect(types).toContain("messaging.published");
		expect(types).toContain("messaging.acked");
	});

	it("dead-letters after max attempts", async () => {
		const bus = createInMemoryMessaging({ tenantId: "t1" });
		await bus.ensureSubscription({
			// SAFETY: assertion required at this I/O or test boundary.
			name: "s1" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			topic: "fail" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			consumerGroup: "g1" as never,
			// SAFETY: assertion required at this I/O or test boundary.
			tenantId: "t1" as never,
			delivery: "at-least-once",
			maxDeliveryAttempts: 2,
		});
		// SAFETY: assertion required at this I/O or test boundary.
		await bus.publish("fail" as never, { x: 1 });
		// SAFETY: assertion required at this I/O or test boundary.
		const r1 = await bus.subscribe("fail" as never, "g1" as never, async () => {
			throw new Error("boom");
		});
		expect(r1.handled).toBe(0);
		// SAFETY: assertion required at this I/O or test boundary.
		const r2 = await bus.subscribe("fail" as never, "g1" as never, async () => {
			throw new Error("boom");
		});
		expect(r2.deadLettered).toBe(1);
		expect(
			bus
				.events()
				.some((e) => e.type === "messaging.delivery.permanent_failure"),
		).toBe(true);
	});

	it("rejects expired leases while keeping consumer groups independent", async () => {
		let time = Date.parse("2026-01-01T00:00:00.000Z");
		const bus = createInMemoryMessaging({
			tenantId: "t1",
			now: () => new Date(time).toISOString(),
		});
		const topic = parseTopicName("orders");
		await bus.publish(topic, { id: 1 });
		const firstGroup = first(
			await bus.consume(topic, parseConsumerGroupId("a"), {
				visibilityTimeoutMs: 10,
			}),
		);
		const secondGroup = first(
			await bus.consume(topic, parseConsumerGroupId("b"), {
				visibilityTimeoutMs: 10,
			}),
		);
		await bus.ack(secondGroup.messageId, secondGroup.leaseId);
		time += 10;
		await expect(
			bus.ack(firstGroup.messageId, firstGroup.leaseId),
		).rejects.toThrow(/lease expired/);
		await expect(
			bus.nack(firstGroup.messageId, firstGroup.leaseId),
		).rejects.toThrow(/lease expired/);
		const redelivery = first(
			await bus.consume(topic, parseConsumerGroupId("a")),
		);
		expect(redelivery.leaseId).not.toBe(firstGroup.leaseId);
		await bus.ack(redelivery.messageId, redelivery.leaseId);
	});

	it("guards unsupported delivery guarantees", () => {
		expect(() =>
			assertDeliverySupported(PORTABLE_MESSAGING_CAPABILITIES, "exactly-once"),
		).toThrow(/does not support/);
		expect(parseDeliveryGuarantee("at-least-once")).toBe("at-least-once");
	});

	it("parses actor placement modes including rivet", () => {
		expect(parseActorPlacementMode("native")).toBe("native");
		expect(parseActorPlacementMode("dapr")).toBe("dapr");
		expect(parseActorPlacementMode("rivet")).toBe("rivet");
		expect(parseActorPlacementMode("celld")).toBe("celld");
		expect(() => parseActorPlacementMode("flux")).toThrow(/actorPlacementMode/);
		expect(() => parseActorPlacementMode("Rivet")).toThrow(
			/actorPlacementMode/,
		);
	});
});
