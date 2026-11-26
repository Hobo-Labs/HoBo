import { parseConsumerGroupId, parseTopicName } from "@hobo/core";
import { first } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	createDaprActorHost,
	createDaprMessaging,
	createDaprRuntimeHost,
	createInMemoryDaprClient,
	defaultDaprRuntimeConfig,
} from "../src/index.js";

describe("dapr live client path", () => {
	it("refuses live:true messaging without client", () => {
		expect(() =>
			createDaprMessaging({
				config: defaultDaprRuntimeConfig("t", "c"),
				live: true,
			}),
		).toThrow(/requires a DaprSidecarClient/);
	});

	it("pubsub round-trip through harnessed daprd client", async () => {
		const client = createInMemoryDaprClient();
		const bus = createDaprMessaging({
			config: defaultDaprRuntimeConfig("acme", "prod"),
			client,
		});
		expect(bus.fidelity).toBe("live");
		expect(bus.client).toBe(client);

		await bus.publish(parseTopicName("events"), { hello: true });
		// SAFETY: assertion required at this I/O or test boundary.
		const batch = await bus.consume("events" as never, "g1" as never);
		expect(batch).toHaveLength(1);
		expect(batch[0]?.body).toEqual({ hello: true });
		await bus.ack(first(batch).messageId, first(batch).leaseId);
		// SAFETY: assertion required at this I/O or test boundary.
		const again = await bus.consume("events" as never, "g1" as never);
		expect(again).toHaveLength(0);
	});

	it("does not nack a handler whose acknowledgement result is unknown", async () => {
		const original = createInMemoryDaprClient();
		let acknowledgements = 0;
		let rejections = 0;
		const client = {
			...original,
			async ack() {
				acknowledgements++;
				throw new Error("reply lost");
			},
			async nack() {
				rejections++;
			},
		};
		const bus = createDaprMessaging({
			config: defaultDaprRuntimeConfig("acme", "prod"),
			client,
		});
		await bus.publish(parseTopicName("events"), { hello: true });
		await expect(
			bus.subscribe(
				parseTopicName("events"),
				parseConsumerGroupId("g1"),
				async () => {},
			),
		).rejects.toMatchObject({ code: "MESSAGING_SETTLEMENT_UNKNOWN" });
		expect({ acknowledgements, rejections }).toEqual({
			acknowledgements: 1,
			rejections: 0,
		});
	});

	it("does not accept a lease from a previous adapter instance", async () => {
		const client = createInMemoryDaprClient();
		const config = defaultDaprRuntimeConfig("acme", "prod");
		const firstBus = createDaprMessaging({ config, client });
		const topic = parseTopicName("events");
		const group = parseConsumerGroupId("g1");
		await firstBus.publish(topic, { hello: true });
		const old = first(await firstBus.consume(topic, group));
		await client.nack(old.messageId, old.consumerGroup);
		const nextBus = createDaprMessaging({ config, client });
		const current = first(await nextBus.consume(topic, group));
		expect(current.leaseId).not.toBe(old.leaseId);
		await expect(nextBus.ack(old.messageId, old.leaseId)).rejects.toMatchObject(
			{ code: "MESSAGING_DELIVERY" },
		);
		await expect(
			nextBus.ack(current.messageId, current.leaseId),
		).resolves.toBeUndefined();
	});

	it("actor host fidelity live with client; single-writer preserved", async () => {
		const client = createInMemoryDaprClient();
		const host = createDaprActorHost({
			config: defaultDaprRuntimeConfig("t", "c"),
			client,
		});
		expect(host.fidelity).toBe("live");
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			/placement conflict/,
		);
		const rem = await host.registerReminder("Cart/1", "tick", 1000);
		expect(rem.reminderId).toContain("dapr-reminder");
		lease.release();
	});

	it("runtime host injects client into actors + messaging", async () => {
		const client = createInMemoryDaprClient();
		const bundle = createDaprRuntimeHost({
			tenantId: "acme",
			campId: "prod",
			client,
		});
		expect(bundle.client).toBe(client);
		expect(bundle.messaging.fidelity).toBe("live");
		expect(bundle.actors.fidelity).toBe("live");
		const ensure = await bundle.host.ensure({ hoboHome: "/tmp" });
		expect(ensure.details?.fidelity).toBe("live");
		expect(ensure.details?.clientPresent).toBe(true);
	});
});
