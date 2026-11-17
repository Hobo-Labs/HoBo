import {
	createMeteringBus,
	parseConsumerGroupId,
	parseTopicName,
	type UsageEvent,
} from "@hobo/core";
import { first } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	createDaprActorHost,
	createDaprMessaging,
	createDaprRuntimeHost,
	createInMemoryDaprClient,
	defaultDaprRuntimeConfig,
} from "../src/index.js";

describe("dapr client path", () => {
	it("refuses live:true messaging without client", () => {
		expect(() =>
			createDaprMessaging({
				config: defaultDaprRuntimeConfig("t", "c"),
				live: true,
			}),
		).toThrow(/requires a DaprSidecarClient/);
	});

	it("requires a live declaration and retains fidelity in metering", async () => {
		const client = createInMemoryDaprClient();
		const config = defaultDaprRuntimeConfig("acme", "prod");
		expect(() => createDaprMessaging({ config, client, live: true })).toThrow(
			/declares live fidelity/,
		);
		const { fidelity, ...unspecified } = client;
		expect(fidelity).toBe("simulated");
		expect(createDaprMessaging({ config, client: unspecified }).fidelity).toBe(
			"simulated",
		);
		const events: UsageEvent[] = [];
		const metering = createMeteringBus([
			{
				sinkId: "test",
				emit(event) {
					events.push(event);
				},
			},
		]);
		const bus = createDaprMessaging({ config, client, metering });
		const topic = parseTopicName("events");
		await bus.publish(topic, { value: 1 });
		await bus.consume(topic, parseConsumerGroupId("group"));
		expect(events.map((event) => event.metadata?.fidelity)).toEqual([
			"simulated",
			"simulated",
		]);
		const declared = createDaprMessaging({
			config,
			client: { ...client, fidelity: "live" },
			live: true,
		});
		expect(declared.fidelity).toBe("live");
	});

	it("pubsub round-trip through harnessed daprd client", async () => {
		const client = createInMemoryDaprClient();
		const bus = createDaprMessaging({
			config: defaultDaprRuntimeConfig("acme", "prod"),
			client,
		});
		expect(bus.fidelity).toBe("simulated");
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

	it("reports simulated actor fidelity with an in-memory client and preserves single-writer", async () => {
		const client = createInMemoryDaprClient();
		const host = createDaprActorHost({
			config: defaultDaprRuntimeConfig("t", "c"),
			client,
		});
		expect(host.fidelity).toBe("simulated");
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			/placement conflict/,
		);
		const rem = await host.registerReminder("Cart/1", "tick", 1000);
		expect(rem.reminderId).toContain("dapr-reminder");
		lease.release();
	});

	it("checks live-client health before reporting readiness", async () => {
		const memory = createInMemoryDaprClient();
		for (const healthy of [true, false]) {
			const client = {
				...memory,
				fidelity: "live" as const,
				async health() {
					return healthy;
				},
			};
			const bundle = createDaprRuntimeHost({ client });
			const result = await bundle.host.ensure({ hoboHome: "/tmp", env: {} });
			expect(result.ready).toBe(healthy);
			expect(result.details?.runtimeReachable).toBe(healthy);
			expect(result.details?.fidelity).toBe(healthy ? "live" : "simulated");
		}
		const client = {
			...memory,
			fidelity: "live" as const,
			async health() {
				throw new Error("offline");
			},
		};
		const result = await createDaprRuntimeHost({ client }).host.ensure({
			hoboHome: "/tmp",
			env: {},
		});
		expect(result.ready).toBe(false);
		expect(result.details?.runtimeReachable).toBe(false);
		const { health, ...withoutHealth } = memory;
		expect(health).toBeDefined();
		const missing = await createDaprRuntimeHost({
			client: { ...withoutHealth, fidelity: "live" },
		}).host.ensure({ hoboHome: "/tmp", env: {} });
		expect(missing.ready).toBe(false);
		const stalled = {
			...memory,
			fidelity: "live" as const,
			health: () => new Promise<boolean>(() => {}),
		};
		const timedOut = await createDaprRuntimeHost({
			client: stalled,
			healthTimeoutMs: 10,
		}).host.ensure({ hoboHome: "/tmp", env: {} });
		expect(timedOut.ready).toBe(false);
		expect(() => createDaprRuntimeHost({ healthTimeoutMs: 0 })).toThrow(
			/healthTimeoutMs/,
		);
	});

	it("reports in-process handlers without claiming sandbox isolation", async () => {
		const bundle = createDaprRuntimeHost();
		const result = await bundle.host.servePrivate({
			hoboHome: "/tmp",
			projectDir: "/tmp",
			privateComponents: [
				{
					resourceName: "echo",
					projectDir: "/tmp",
					handler: () => new Response("ok"),
				},
			],
		});
		expect(result.isolation).toMatchObject({
			isolateBoundary: "in_process",
			privateSandboxes: 0,
			details: { sidecar: false, handlerCount: 1 },
		});
		expect(
			await (
				await result.handlers.get("echo")?.(new Request("https://example.test"))
			)?.text(),
		).toBe("ok");
		await result.close();
	});

	it("runtime host injects client into actors + messaging", async () => {
		const client = createInMemoryDaprClient();
		const bundle = createDaprRuntimeHost({
			tenantId: "acme",
			campId: "prod",
			client,
		});
		expect(bundle.client).toBe(client);
		expect(bundle.messaging.fidelity).toBe("simulated");
		expect(bundle.actors.fidelity).toBe("simulated");
		const ensure = await bundle.host.ensure({ hoboHome: "/tmp" });
		expect(ensure.details?.fidelity).toBe("simulated");
		expect(ensure.details?.clientPresent).toBe(true);
	});
});
