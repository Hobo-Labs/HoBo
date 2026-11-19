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

		await bus.publish("events" as never, { hello: true });
		const batch = await bus.consume("events" as never, "g1" as never);
		expect(batch).toHaveLength(1);
		expect(batch[0]?.body).toEqual({ hello: true });
		bus.ack(first(batch).messageId, first(batch).leaseId);
		await bus.flush?.();
		const again = await bus.consume("events" as never, "g1" as never);
		expect(again).toHaveLength(0);
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
