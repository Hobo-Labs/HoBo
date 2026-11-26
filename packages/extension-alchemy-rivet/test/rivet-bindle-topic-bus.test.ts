import { durableMessagingOperation } from "@hobo/core";
import {
	createDurableMessagingLifecycle,
	createDurableMessagingLimitsGrant,
	createDurableMessagingPortMetadataGrant,
} from "@hobo/runtime/durable-messaging-host";
import {
	createRivetDurableTopicBusActor,
	createRivetDurableTopicMetadataGrant,
} from "@hobo/runtime-rivet";
import { expect, it } from "vitest";
import { bindle } from "../../bindles/src/bindle.js";
import { createSqliteBusConformanceHost } from "../../runtimes/runtime-rivet/test/fixtures/durable-topic-bus-conformance.js";
import { createRivetBindleTopicBusApplication } from "../src/rivet-http-topic-bus.js";

it("gates an HTTP application's scoped topic binding on real journal provisioning", async () => {
	const fixture = await createSqliteBusConformanceHost();
	try {
		const clientOptions = {
			...(await fixture.open("tenant-a")),
			metadataGrant: createRivetDurableTopicMetadataGrant(),
		};
		const bus = createRivetDurableTopicBusActor({
			actorName: clientOptions.binding.actorName,
			semanticDigest: clientOptions.binding.semanticDigest,
			now: () => 1_000,
			resolveScope: () => ({ tenant: "tenant-a", instance: "orders" }),
			authorize: () => true,
			authorizeInstanceScope: () => true,
			verifyIngress: () => true,
		});
		const definition = bindle("shop", (b) => {
			const orders = b.topic().allow("publish");
			return { orders, web: b.web().dependsOn(orders) };
		});
		let starts = 0;
		let permitsProvisioning = false;
		let scopeValid = true;
		const app = createRivetBindleTopicBusApplication({
			actorName: "web",
			bus,
			clientOptions,
			verifyScope: () => scopeValid,
			authorize: () => true,
			bindle: {
				bindleName: definition.name,
				applicationName: "web",
				resources: definition.resources,
				edges: definition.edges,
				bindings: [
					{ resourceName: "orders", topic: "orders", subscriptions: [] },
				],
			},
			operations: [
				{
					topic: "orders",
					operation: durableMessagingOperation(10_000, "topicorders12345"),
				},
			],
			hostOptions: (port) => {
				const portMetadataGrant = createDurableMessagingPortMetadataGrant({
					port,
					limits: clientOptions.binding.limits,
					verify: () => true,
				});
				return {
					provisioning: {
						limitsGrant: createDurableMessagingLimitsGrant(),
						lifecycle: createDurableMessagingLifecycle(),
						portMetadataGrant,
						authorize: () => permitsProvisioning,
					},
					application: {
						limitsGrant: createDurableMessagingLimitsGrant(),
						lifecycle: createDurableMessagingLifecycle(),
						portMetadataGrant,
						verify: () => true,
					},
				};
			},
			application: (host) => {
				starts++;
				const topic = host.topic("orders");
				return async () => {
					const outcome = await topic.publish({
						operation: {
							id: durableMessagingOperation(10_000, "publishnonce1234").id,
							expiresAtMs: 10_000n,
						},
						message: {
							id: "order-1",
							subject: "created",
							payload: new Uint8Array([7]),
							attributes: [],
						},
					});
					return Response.json({
						tag: outcome.tag,
						messageId:
							outcome.tag === "committed" ? outcome.val.messageId : undefined,
					});
				};
			},
		});
		const request = () =>
			app.http.handle(
				{ name: "web", key: ["tenant-a"], vars: {} },
				new Request("https://app.test/"),
			);
		const refused = await request();
		expect(refused.status).toBe(503);
		expect(await refused.json()).toEqual({
			status: "topic-unavailable",
			reason: "unknown",
		});
		expect(starts).toBe(0);
		permitsProvisioning = true;
		const held = await fixture.controls.holdNextMutation("before-dispatch");
		const inFlight = request();
		await held.reached;
		scopeValid = false;
		await held.release();
		expect((await inFlight).status).toBe(503);
		expect(starts).toBe(0);
		scopeValid = true;
		const accepted = await request();
		const payload = await accepted.json();
		expect({ status: accepted.status, payload }).toEqual({
			status: 200,
			payload: { tag: "committed", messageId: "order-1" },
		});
		expect(starts).toBe(1);
	} finally {
		await fixture.controls.close();
	}
});
