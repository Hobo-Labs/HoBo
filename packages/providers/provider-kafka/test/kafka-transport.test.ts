import { parseConsumerGroupId, parseTopicName } from "@hobo/core";
import { first } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	createInMemoryKafkaTransport,
	createKafkaMessaging,
	localRedpandaCluster,
} from "../src/index.js";

describe("kafka live transport path", () => {
	it("refuses live:true without transport", () => {
		expect(() =>
			createKafkaMessaging({
				cluster: localRedpandaCluster("t1"),
				live: true,
			}),
		).toThrow(/requires a KafkaBrokerTransport/);
	});

	it("labels simulated without transport", () => {
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("t1"),
		});
		expect(bus.fidelity).toBe("simulated");
		expect(bus.transport).toBeNull();
	});

	it("exercises live client code path via in-memory broker transport", async () => {
		const transport = createInMemoryKafkaTransport();
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("acme"),
			transport,
		});
		expect(bus.fidelity).toBe("live");
		expect(bus.transport).toBe(transport);

		const topic = parseTopicName("orders");
		await bus.publish(topic, { id: 1 }, { key: "k1", idempotencyKey: "ik1" });
		const dedup = await bus.publish(
			topic,
			{ id: 1 },
			{ key: "k1", idempotencyKey: "ik1" },
		);
		expect(dedup.deduped).toBe(true);

		const batch = await bus.consume(topic, parseConsumerGroupId("workers"), {
			maxMessages: 10,
		});
		expect(batch).toHaveLength(1);
		expect(batch[0]?.body).toEqual({ id: 1 });

		await bus.ack(first(batch).messageId, first(batch).leaseId);

		const again = await bus.consume(topic, parseConsumerGroupId("workers"));
		expect(again).toHaveLength(0);

		const types = bus.events().map((e) => e.type);
		expect(types).toContain("messaging.published");
		expect(types).toContain("messaging.acked");
	});

	it("waits for broker acknowledgement and exposes an uncertain failure", async () => {
		const original = createInMemoryKafkaTransport();
		let releaseCommit: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		let commitCalls = 0;
		let releaseCalls = 0;
		const transport = {
			...original,
			async commit() {
				commitCalls++;
				await gate;
				throw new Error("reply lost");
			},
			async release(request: Parameters<typeof original.release>[0]) {
				releaseCalls++;
				await original.release(request);
			},
		};
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("acme"),
			transport,
		});
		const topic = parseTopicName("orders");
		await bus.publish(topic, { id: 1 });
		const message = first(
			await bus.consume(topic, parseConsumerGroupId("workers")),
		);
		const pending = bus.ack(message.messageId, message.leaseId);
		expect(pending).toBeInstanceOf(Promise);
		expect(bus.events().some((event) => event.type === "messaging.acked")).toBe(
			false,
		);
		releaseCommit();
		await expect(pending).rejects.toMatchObject({
			code: "MESSAGING_SETTLEMENT_UNKNOWN",
		});
		await expect(
			bus.nack(message.messageId, message.leaseId),
		).rejects.toMatchObject({ code: "MESSAGING_SETTLEMENT_UNKNOWN" });
		expect({ commitCalls, releaseCalls }).toEqual({
			commitCalls: 1,
			releaseCalls: 0,
		});
	});

	it("does not release a message after an acknowledgement reply is lost", async () => {
		const original = createInMemoryKafkaTransport();
		let commits = 0;
		let releases = 0;
		const transport = {
			...original,
			async commit() {
				commits++;
				throw new Error("reply lost");
			},
			async release() {
				releases++;
			},
		};
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("acme"),
			transport,
		});
		const topic = parseTopicName("orders");
		await bus.publish(topic, { id: 1 });
		await expect(
			bus.subscribe(topic, parseConsumerGroupId("workers"), async () => {}),
		).rejects.toMatchObject({ code: "MESSAGING_SETTLEMENT_UNKNOWN" });
		expect({ commits, releases }).toEqual({ commits: 1, releases: 0 });
	});

	it("reports a committed acknowledgement when local observation fails", async () => {
		let failClock = false;
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("acme"),
			transport: createInMemoryKafkaTransport(),
			now: () => {
				if (failClock) throw new Error("clock unavailable");
				return "2026-01-01T00:00:00.000Z";
			},
		});
		const topic = parseTopicName("orders");
		const group = parseConsumerGroupId("workers");
		await bus.publish(topic, { id: 1 });
		const message = first(await bus.consume(topic, group));
		failClock = true;
		await expect(
			bus.ack(message.messageId, message.leaseId),
		).rejects.toMatchObject({
			code: "MESSAGING_SETTLEMENT_COMMITTED",
			operation: "ack",
		});
		failClock = false;
		await expect(
			bus.ack(message.messageId, message.leaseId),
		).rejects.toMatchObject({ code: "MESSAGING_DELIVERY" });
		expect(await bus.consume(topic, group)).toEqual([]);
	});

	it("routes produce through the injected transport (not pure emulator)", async () => {
		const transport = createInMemoryKafkaTransport();
		const produceCalls: unknown[] = [];
		const spy: typeof transport = {
			...transport,
			kind: "kafka-broker-transport",
			async produce(req) {
				produceCalls.push(req);
				return transport.produce(req);
			},
			async ensureTopic(t, o) {
				return transport.ensureTopic(t, o);
			},
			async fetch(r) {
				return transport.fetch(r);
			},
			async commit(r) {
				return transport.commit(r);
			},
			async release(r) {
				return transport.release(r);
			},
		};
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("acme"),
			transport: spy,
		});
		await bus.publish(parseTopicName("t"), { x: 1 });
		expect(produceCalls).toHaveLength(1);
		expect(bus.fidelity).toBe("live");
	});
});
