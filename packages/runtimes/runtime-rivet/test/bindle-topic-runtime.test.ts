import { durableMessagingOperation } from "@hobo/core";
import { expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import {
	createBindleTopicWitHost,
	createDurableMessagingLifecycle,
	createDurableMessagingLimitsGrant,
	createDurableMessagingPortMetadataGrant,
} from "../../../runtime/src/durable-messaging-host.js";
import { createRivetDurableTopicClient } from "../src/durable-topic-client.js";
import { createSqliteBusConformanceHost } from "./fixtures/durable-topic-bus-conformance.js";

it("uses the generic named topic client with the durable SQLite actor", async () => {
	const fixture = await createSqliteBusConformanceHost();
	try {
		const options = await fixture.open("tenant-a");
		const port = createRivetDurableTopicClient(options);
		const op = (nonce: string) => durableMessagingOperation(10_000, nonce);
		for (const [topic, nonce] of [
			["orders", "topicorders12345"],
			["orders-dlq", "topicdead1234567"],
		] as const)
			expect(
				(await port.ensureTopic({ operation: op(nonce), topic })).status,
			).toBe("committed");
		const definition = bindle("shop", (b) => {
			const orders = b.topic().allow("publish", "subscribe");
			return { orders, web: b.web().dependsOn(orders) };
		});
		const metadata = createDurableMessagingPortMetadataGrant({
			port,
			limits: options.binding.limits,
			verify: (claim) =>
				claim.port === port &&
				JSON.stringify(claim.limits) === JSON.stringify(options.binding.limits),
		});
		const host = createBindleTopicWitHost(
			port,
			{
				bindleName: definition.name,
				applicationName: "web",
				resources: definition.resources,
				edges: definition.edges,
				bindings: [
					{
						resourceName: "orders",
						topic: "orders",
						subscriptions: [
							{ consumerGroup: "workers", deadLetterTopic: "orders-dlq" },
						],
					},
				],
			},
			{
				lifecycle: createDurableMessagingLifecycle(),
				limitsGrant: createDurableMessagingLimitsGrant(),
				portMetadataGrant: metadata,
				verify: (claim) =>
					claim.port === port &&
					claim.bindleName === "shop" &&
					claim.applicationName === "web" &&
					claim.binding.resourceName === "orders" &&
					(claim.subscription === undefined ||
						claim.subscription.deadLetterTopic === "orders-dlq"),
			},
		);
		const topic = host.topic("orders");
		const operation = (nonce: string) => {
			const value = op(nonce);
			return { id: value.id, expiresAtMs: BigInt(value.expiresAtMs) };
		};
		expect(
			(
				await topic.ensureSubscription({
					operation: operation("subscription1234"),
					consumerGroup: "workers",
					maxDeliveryAttempts: 3,
					startAt: "earliest",
				})
			).tag,
		).toBe("committed");
		expect(
			(
				await topic.publish({
					operation: operation("publishnonce1234"),
					message: {
						id: "order-1",
						subject: "created",
						payload: new Uint8Array([7]),
						attributes: [],
					},
				})
			).tag,
		).toBe("committed");
		const received = await topic.consume({
			operation: operation("consumenonce1234"),
			consumerGroup: "workers",
			maxMessages: 1,
			visibilityTimeoutMs: 100n,
		});
		expect(received.tag).toBe("committed");
		if (received.tag !== "committed" || received.val[0] === undefined)
			throw new Error("delivery missing");
		const delivery = received.val[0];
		expect(delivery.message.payload).toEqual(new Uint8Array([7]));
		expect(
			(
				await topic.ack({
					operation: operation("acknowledgenonce"),
					consumerGroup: "workers",
					messageId: delivery.message.id,
					sequence: delivery.sequence,
					leaseId: delivery.leaseId,
				})
			).tag,
		).toBe("committed");
		host.revoke();
		expect(
			(
				await topic.publish({
					operation: operation("anothernonce1234"),
					message: {
						id: "order-2",
						subject: "created",
						payload: new Uint8Array(),
						attributes: [],
					},
				})
			).tag,
		).toBe("unknown");
	} finally {
		await fixture.controls.close();
	}
});
