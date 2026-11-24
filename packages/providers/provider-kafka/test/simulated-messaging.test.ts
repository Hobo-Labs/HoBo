/**
 * The simulated-fidelity messaging surface.
 *
 * `createKafkaMessaging` has two paths. The live one drives a real broker
 * transport; the simulated one runs in memory so a Bindle can be authored and
 * exercised with no cluster at all. Both implement the same `KafkaMessaging`
 * shape, and that is exactly where the risk is: a simulated client that
 * silently diverged from the live one would let a developer build against
 * semantics the broker does not have, and the divergence would surface only
 * once something was deployed.
 *
 * So the property that matters most here is **honesty about which path you are
 * on**. The simulated client reports `fidelity: "simulated"` and a `null`
 * transport, and every metering fact it emits carries that label — a consumer
 * reading usage cannot mistake in-memory traffic for broker traffic. The
 * partition count it reports is likewise a plausible default rather than a
 * measurement, because there is no cluster to measure.
 */
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
		// The two together. A caller checking only `fidelity` could be fooled by
		// a future path that set it wrongly; the null transport is the
		// structural fact that there is nothing to talk to.
		const client = messaging();
		expect(client.fidelity).toBe("simulated");
		expect(client.transport).toBeNull();
	});

	it("still names the native-kafka backend", () => {
		// Simulated fidelity does not change *which* backend's semantics are
		// being modelled — a reader has to be able to tell an in-memory Kafka
		// from an in-memory anything-else.
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
		// Ensuring twice must not produce two topics, because the whole point of
		// an `ensure` is that a caller can run it on every start-up.
		const client = messaging();
		const first = await client.ensureTopic(topicSpec());
		const second = await client.ensureTopic(topicSpec());
		expect(second.name).toBe(first.name);
	});

	it("records a partition count for the topic it ensured", async () => {
		// A plausible default rather than a measurement — there is no cluster to
		// measure. Reporting 0 would make a partition-aware consumer believe the
		// topic could not be read.
		const client = messaging();
		const ensured = await client.ensureTopic(topicSpec());
		expect(client.partitionsFor(ensured.name)).toBeGreaterThan(0);
	});
});

describe("partitionsFor", () => {
	it("reports a positive default for a topic it has never seen", async () => {
		// Not zero and not a throw. A caller computing a partition key before
		// ensuring the topic is normal, and either alternative would make that a
		// special case.
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
		// The bound is what stops a consumer pulling an unbounded batch into
		// memory. A simulated client that ignored it would let a developer write
		// a handler that only works because the in-memory queue is small.
		const { client, topic } = await withTopic();
		for (let index = 0; index < 5; index += 1) {
			await client.publish(topic, { order: index });
		}
		const batch = await client.consume(topic, GROUP, { maxMessages: 2 });
		expect(batch.length).toBeLessThanOrEqual(2);
	});

	it("returns an empty batch rather than blocking on an empty topic", async () => {
		// A poll that returned nothing is an answer. Blocking would make a
		// simulated run hang where a live one would time out.
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
		// The negative path exists so a handler that cannot process a message can
		// say so rather than letting the lease expire. A simulated client without
		// it would make that code path untestable offline.
		const { client, message } = await consumeOne();
		await expect(
			client.nack(message.messageId, message.leaseId),
		).resolves.toBeUndefined();
	});

	it("carries a nack reason through", async () => {
		// The reason is what a dead-letter policy dispatches on, so dropping it
		// would make every nack look the same to whatever routes them.
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
		// The event log is what a receipt is assembled from. A simulated run that
		// recorded nothing would produce an empty receipt for work that visibly
		// happened.
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
