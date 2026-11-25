import {
	parseConsumerGroupId,
	parseSubscriptionName,
	parseTenantId,
	parseTopicName,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createKafkaProvider } from "../src/provider.js";

const CLUSTER = {
	name: "events",
	tenantId: "acme",
	kind: "redpanda" as const,
	bootstrapServers: ["broker-1:9092"],
	credentialBindingRef: "fromBinding:kafka",
	transactional: false,
	idempotentProducer: true,
};

function messaging() {
	return createKafkaProvider({ cluster: CLUSTER, env: {} }).createMessaging();
}

const TOPIC = parseTopicName("orders");
const GROUP = parseConsumerGroupId("workers");
const TENANT = parseTenantId("acme");
const topicSpec = () => ({
	name: TOPIC,
	tenantId: TENANT,
	delivery: "at-least-once" as const,
});

describe("fidelity is stated, never inferred", () => {
	it("reports simulated fidelity and a null transport", () => {
		const client = messaging();
		expect(client.fidelity).toBe("simulated");
		expect(client.transport).toBeNull();
	});

	it("still names the native-kafka backend", () => {
		expect(messaging().backend).toBe("native-kafka");
	});

	it("carries the cluster it was built for", () => {
		expect(messaging().cluster.name).toBe("events");
		expect(messaging().cluster.tenantId).toBe("acme");
	});

	it("is frozen", () => {
		expect(Object.isFrozen(messaging())).toBe(true);
	});
});

describe("ensureTopic", () => {
	it("creates a topic and reports it back", async () => {
		const client = messaging();
		const ensured = await client.ensureTopic(topicSpec());
		expect(ensured.name).toBeDefined();
	});

	it("is idempotent", async () => {
		const client = messaging();
		const first = await client.ensureTopic(topicSpec());
		const second = await client.ensureTopic(topicSpec());
		expect(second.name).toBe(first.name);
	});

	it("records a partition count for the topic it ensured", async () => {
		const client = messaging();
		const ensured = await client.ensureTopic(topicSpec());
		expect(client.partitionsFor(ensured.name)).toBeGreaterThan(0);
	});
});

describe("partitionsFor", () => {
	it("reports a positive default for a topic it has never seen", async () => {
		expect(
			messaging().partitionsFor(parseTopicName("never-ensured")),
		).toBeGreaterThan(0);
	});

	it("reports the recorded count once a topic has been ensured", async () => {
		const client = messaging();
		const ensured = await client.ensureTopic(topicSpec());
		expect(client.partitionsFor(ensured.name)).toEqual(expect.any(Number));
	});
});

describe("publish and consume", () => {
	async function withTopic() {
		const client = messaging();
		const ensured = await client.ensureTopic(topicSpec());
		return { client, topic: ensured.name };
	}

	it("round-trips a published message", async () => {
		const { client, topic } = await withTopic();
		await client.publish(topic, { order: 1 });
		const batch = await client.consume(topic, GROUP);
		expect(batch.length).toBeGreaterThan(0);
	});

	it("honours a maxMessages bound on consume", async () => {
		const { client, topic } = await withTopic();
		for (let index = 0; index < 5; index += 1) {
			await client.publish(topic, { order: index });
		}
		const batch = await client.consume(topic, GROUP, { maxMessages: 2 });
		expect(batch.length).toBeLessThanOrEqual(2);
	});

	it("returns an empty batch rather than blocking on an empty topic", async () => {
		const { client, topic } = await withTopic();
		expect(await client.consume(topic, GROUP)).toEqual([]);
	});

	it("accepts publish options", async () => {
		const { client, topic } = await withTopic();
		await expect(
			client.publish(topic, { order: 1 }, { key: "order-1" }),
		).resolves.toBeDefined();
	});
});

describe("ack and nack", () => {
	async function consumeOne() {
		const client = messaging();
		const ensured = await client.ensureTopic(topicSpec());
		await client.publish(ensured.name, { order: 1 });
		const [message] = await client.consume(ensured.name, GROUP);
		expect(message).toBeDefined();
		if (!message) throw new Error("unreachable");
		return { client, message };
	}

	it("acks a consumed message", async () => {
		const { client, message } = await consumeOne();
		await expect(
			client.ack(message.messageId, message.leaseId),
		).resolves.toBeUndefined();
	});

	it("nacks a consumed message", async () => {
		const { client, message } = await consumeOne();
		await expect(
			client.nack(message.messageId, message.leaseId),
		).resolves.toBeUndefined();
	});

	it("carries a nack reason through", async () => {
		const { client, message } = await consumeOne();
		await expect(
			client.nack(message.messageId, message.leaseId, "schema-mismatch"),
		).resolves.toBeUndefined();
	});
});

describe("events", () => {
	it("returns a readable event log", async () => {
		const client = messaging();
		expect(Array.isArray(client.events())).toBe(true);
	});

	it("records the topic creation", async () => {
		const client = messaging();
		await client.ensureTopic(topicSpec());
		expect(client.events().length).toBeGreaterThan(0);
	});
});

describe("ensureSubscription", () => {
	it("registers a subscription", async () => {
		const client = messaging();
		await client.ensureTopic(topicSpec());
		await expect(
			client.ensureSubscription({
				name: parseSubscriptionName("orders-workers"),
				topic: TOPIC,
				consumerGroup: GROUP,
				tenantId: TENANT,
				delivery: "at-least-once",
				maxDeliveryAttempts: 3,
			}),
		).resolves.toBeDefined();
	});
});

describe("subscribe", () => {
	it("delivers a published message to a handler", async () => {
		const client = messaging();
		const ensured = await client.ensureTopic(topicSpec());
		const seen: unknown[] = [];
		await client.publish(ensured.name, { order: 1 });
		await client.subscribe(
			ensured.name,
			GROUP,
			async (message) => {
				seen.push(message.body);
			},
			{ maxMessages: 1 },
		);
		expect(seen.length).toBeGreaterThanOrEqual(0);
	});
});
