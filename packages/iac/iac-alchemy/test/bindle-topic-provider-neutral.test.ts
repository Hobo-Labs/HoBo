import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import type { Stack } from "alchemy/Stack";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import type { BindleEntrypoint } from "../../../bindles/src/types.js";
import {
	DURABLE_MESSAGING_LIMITS,
	type DurableMessaging,
} from "../../../core/src/index.js";
import {
	createBindleTopicWitHost,
	createDurableMessagingLifecycle,
	createDurableMessagingLimitsGrant,
} from "../../../runtime/src/durable-messaging-host.js";
import {
	type AlchemyPrimitiveMapper,
	mapBindleToAlchemy,
} from "../src/bindle.js";

function portFixture(): DurableMessaging {
	const unused = async () => {
		throw new Error("unexpected operation");
	};
	return {
		limits: DURABLE_MESSAGING_LIMITS,
		ensureTopic: unused,
		ensureSubscription: unused,
		publish: vi.fn<DurableMessaging["publish"]>(async ({ message }) => ({
			status: "committed",
			value: { messageId: message.id, sequence: 1 },
		})),
		consume: unused,
		ack: unused,
		nack: unused,
		compact: unused,
		events: unused,
	};
}

async function verifyProvider<Type extends string>(type: Type) {
	type Physical = Resource<Type, object, { id: string }>;
	const Physical = Resource<Physical>(type);
	const entrypoint = () => "web";
	const definition = bindle("shop", (b) => {
		const orders = b.topic().allow("publish");
		const audit = b.topic().allow("publish").dependsOn(orders);
		return {
			orders,
			audit,
			web: b
				.web(entrypoint)
				.with(sessionReplay({ enabled: false }))
				.dependsOn(orders, audit),
		};
	});
	type Mapper = AlchemyPrimitiveMapper<
		BindleEntrypoint,
		typeof definition.requirements,
		Stack | Provider.Provider<Physical>
	>;
	const shared = (input: Parameters<Mapper["build"]>[0], owner: string) => {
		const primary = input.dependencies[owner];
		if (primary === undefined) throw new Error("missing shared resource");
		return primary;
	};
	const topic: Mapper = {
		resourceTypes: [type],
		operations: ["publish"],
		annotations: [],
		bindsEntrypoint: false,
		build: (input) =>
			input.declaration.name === "orders"
				? Effect.gen(function* () {
						const primary = yield* Physical("bus", {});
						return { primary, resources: [primary], boundDependencies: [] };
					})
				: Effect.succeed({
						primary: shared(input, "orders"),
						resources: [],
						sharedDependency: "orders",
						boundDependencies: ["orders"],
					}),
	};
	const web: Mapper = {
		resourceTypes: [type],
		operations: [],
		annotations: ["hobo:session-replay"],
		bindsEntrypoint: true,
		build: (input) =>
			Effect.succeed({
				primary: shared(input, "orders"),
				resources: [],
				sharedDependency: "orders",
				boundDependencies: ["orders", "audit"],
				boundEntrypoint: entrypoint,
			}),
	};
	const mapping = await Effect.runPromise(
		mapBindleToAlchemy(
			definition,
			{ topic, web },
			{
				assessRequirements: () => ({ status: "supported" }),
			},
		).pipe(
			Effect.provideService(StackContext, {
				name: "Shop",
				stage: "test",
				resources: {},
				bindings: {},
				actions: {},
			}),
			Effect.provide(
				Provider.succeed(Physical, {
					reconcile: () => Effect.succeed({ id: "bus" }),
					delete: () => Effect.void,
				}),
			),
		),
	);
	expect(mapping.resources).toHaveLength(1);
	expect(mapping.primary.orders).toBe(mapping.primary.audit);
	expect(mapping.primary.orders).toBe(mapping.primary.web);
	const port = portFixture();
	const bound = createBindleTopicWitHost(
		port,
		{
			bindleName: definition.name,
			applicationName: "web",
			resources: definition.resources,
			edges: definition.edges,
			bindings: [
				{ resourceName: "orders", topic: "orders", subscriptions: [] },
				{ resourceName: "audit", topic: "audit", subscriptions: [] },
			],
		},
		{
			lifecycle: createDurableMessagingLifecycle(),
			limitsGrant: createDurableMessagingLimitsGrant(),
			verify: (claim) =>
				claim.port === port &&
				claim.bindleName === definition.name &&
				claim.applicationName === "web" &&
				mapping.primary[claim.binding.resourceName] === mapping.primary.web,
		},
	);
	const operation = (nonce: string) => ({
		id: `v1.2000000000000.${nonce}`,
		expiresAtMs: 2000000000000n,
	});
	const message = {
		id: "msg",
		subject: "created",
		payload: new Uint8Array([1]),
		attributes: [],
	};
	for (const [topicName, nonce] of [
		["orders", "ordersnonce12345"],
		["audit", "auditnonce123456"],
	] as const)
		expect(
			(
				await bound.host.publish({
					operation: operation(nonce),
					topic: topicName,
					message,
				})
			).tag,
		).toBe("committed");
	expect(
		(
			await bound.host.publish({
				operation: operation("othernonce123456"),
				topic: "other",
				message,
			})
		).tag,
	).toBe("unknown");
	expect(port.publish).toHaveBeenCalledTimes(2);
}

describe("provider-neutral Alchemy topic mapping with test providers", () => {
	for (const type of ["Spec.First", "Spec.Second"] as const)
		it(`maps declared topics and counts ${type} once`, async () =>
			verifyProvider(type));
});
