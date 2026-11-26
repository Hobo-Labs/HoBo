import { durableMessagingOperation } from "@hobo/core";
import {
	createDurableMessagingLifecycle,
	createDurableMessagingLimitsGrant,
	createDurableMessagingPortMetadataGrant,
} from "@hobo/runtime/durable-messaging-host";
import {
	createRivetDurableTopicBusActor,
	createRivetDurableTopicMetadataGrant,
	RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	RIVET_DURABLE_TOPIC_BUS_LIMITS,
} from "@hobo/runtime-rivet";
import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import { bindle } from "../../../bindles/src/bindle.ts";
import { sessionReplay } from "../../../bindles/src/session-replay.ts";
import {
	bindRivetBindleTopicEntrypoint,
	createRivetBindleTopicBusApplication,
} from "../../src/rivet-http-topic-bus.ts";

const expiry = Number(process.env.HOBO_TEST_TOPIC_EXPIRY);
if (!Number.isSafeInteger(expiry))
	throw new Error("test operation expiry is missing");
const digest = `sha256:${"d".repeat(64)}`;
export const bus = createRivetDurableTopicBusActor({
	actorName: "events",
	semanticDigest: digest,
	now: Date.now,
	resolveScope: ({ actorKey }) => ({ tenant: actorKey[0], instance: "orders" }),
	authorize: ({ actorKey, headers }) =>
		actorKey[0] === "tenant-a" && headers.get("authorization") === "test",
	authorizeInstanceScope: ({ actorKey }) => actorKey[0] === "tenant-a",
	verifyIngress: () => true,
});
const shop = bindle("shop", (b) => {
	const orders = b.topic().allow("publish");
	return {
		orders,
		web: b
			.web()
			.with(sessionReplay({ enabled: false }))
			.dependsOn(orders),
	};
});
const binding = {
	actorName: "events",
	actorKey: ["tenant-a"],
	tenant: "tenant-a",
	instance: "orders",
	semanticDigest: digest,
	limits: RIVET_DURABLE_TOPIC_BUS_LIMITS,
	actorCapabilities: RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
};
export const application = createRivetBindleTopicBusApplication({
	actorName: "web",
	bus,
	clientOptions: {
		binding,
		metadataGrant: createRivetDurableTopicMetadataGrant(),
		verifyTransport: () => true,
		authorize: () => ({ authorization: "test" }),
		revalidate: () => true,
		fetch: (path, init) =>
			createClient({
				endpoint: process.env.RIVET_ENDPOINT,
				token: process.env.RIVET_TOKEN,
				disableMetadataLookup: true,
			})
				.events.getOrCreate(["tenant-a"])
				.fetch(path, init),
	},
	verifyScope: () => true,
	authorize: ({ actorKey }) => actorKey[0] === "tenant-a",
	bindle: {
		bindleName: shop.name,
		applicationName: "web",
		resources: shop.resources,
		edges: shop.edges,
		bindings: [{ resourceName: "orders", topic: "orders", subscriptions: [] }],
	},
	operations: [
		{
			topic: "orders",
			operation: durableMessagingOperation(expiry, "topicorders12345"),
		},
	],
	hostOptions: (port) => {
		const portMetadataGrant = createDurableMessagingPortMetadataGrant({
			port,
			limits: binding.limits,
			verify: () => true,
		});
		return {
			provisioning: {
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
				portMetadataGrant,
				authorize: () => true,
			},
			application: {
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
				portMetadataGrant,
				verify: () => true,
			},
		};
	},
	application: (topics) => async () => {
		const operation = durableMessagingOperation(expiry, "publishnonce1234");
		const result = await topics.topic("orders").publish({
			operation: {
				id: operation.id,
				expiresAtMs: BigInt(operation.expiresAtMs),
			},
			message: {
				id: "order-1",
				subject: "created",
				payload: new Uint8Array([7]),
				attributes: [],
			},
		});
		return Response.json({
			tag: result.tag,
			messageId: result.tag === "committed" ? result.val.messageId : null,
		});
	},
});
export const deployed = bindRivetBindleTopicEntrypoint(shop, application);
export const registry = setup({
	use: { web: application.http.actor, events: bus.actor },
	noWelcome: true,
	startEngine: false,
	shutdown: { gracePeriodMs: 2000 },
});
