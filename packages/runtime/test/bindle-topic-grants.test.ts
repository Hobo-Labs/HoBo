import { DURABLE_MESSAGING_LIMITS, type DurableMessaging } from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import { bindle } from "../../bindles/src/bindle.js";
import {
	compileBindleTopicGrants,
	createBindleTopicWitHost,
	createDurableMessagingLifecycle,
	createDurableMessagingLimitsGrant,
	createDurableTopicPolicy,
} from "../src/durable-messaging-host.js";

function portFixture(): DurableMessaging {
	return {
		limits: DURABLE_MESSAGING_LIMITS,
		ensureTopic: async ({ topic }) => ({
			status: "committed",
			value: { topic },
		}),
		ensureSubscription: async ({ subscription }) => ({
			status: "committed",
			value: {
				subscription,
				firstAvailableSequence: 1,
				historyTruncated: false,
			},
		}),
		publish: vi.fn<DurableMessaging["publish"]>(async ({ message }) => ({
			status: "committed",
			value: { messageId: message.id, sequence: 1 },
		})),
		consume: async () => ({ status: "committed", value: [] }),
		ack: async ({ messageId, sequence }) => ({
			status: "committed",
			value: { messageId, sequence },
		}),
		nack: async ({ messageId, sequence }) => ({
			status: "committed",
			value: { messageId, sequence, disposition: "released" },
		}),
		compact: async ({ topic }) => ({
			status: "committed",
			value: { topic, firstAvailableSequence: 1, removedMessages: 0 },
		}),
		events: async ({ afterSequence }) => ({
			status: "ok",
			events: [],
			firstAvailableSequence: 1,
			nextAfterSequence: afterSequence,
			hasMore: false,
		}),
	};
}

function fixture() {
	const definition = bindle("shop", (builder) => {
		const orders = builder.topic().allow("publish", "subscribe");
		const audit = builder.topic().allow("publish");
		const web = builder.web().dependsOn(orders);
		return { orders, audit, web };
	});
	return {
		applicationName: "web",
		resources: definition.resources,
		edges: definition.edges,
		bindings: [
			{
				resourceName: "orders",
				topic: "tenant.orders",
				subscriptions: [
					{
						consumerGroup: "fulfillment",
						deadLetterTopic: "tenant.orders-dlq",
					},
				],
			},
		],
	};
}

describe("provider-neutral Bindle topic grants", () => {
	it("binds a named application topic to the host's configured runtime topic and subscription", async () => {
		const port = portFixture();
		const ensure = vi.fn(port.ensureSubscription);
		const bound = createBindleTopicWitHost(
			{ ...port, ensureSubscription: ensure },
			{ ...fixture(), bindleName: "shop" },
			{
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
				verify: () => true,
			},
		);
		const topic = bound.topic("orders");
		expect(topic.publishEnabled).toBe(true);
		expect(topic.subscriptions).toEqual([
			{ consumerGroup: "fulfillment", deadLetterTopic: "tenant.orders-dlq" },
		]);
		expect(() => bound.topic("audit")).toThrow();
		const operation = {
			id: "v1.2000000000000.abcdefghijklmnop",
			expiresAtMs: 2000000000000n,
		};
		const subscriptionOperation = {
			id: "v1.2000000000000.subscription1234",
			expiresAtMs: 2000000000000n,
		};
		const otherOperation = {
			id: "v1.2000000000000.unknownnonce1234",
			expiresAtMs: 2000000000000n,
		};
		const message = {
			id: "m",
			subject: "created",
			payload: new Uint8Array([1]),
			attributes: [],
		};
		expect((await topic.publish({ operation, message })).tag).toBe("committed");
		expect(port.publish).toHaveBeenCalledWith(
			expect.objectContaining({ topic: "tenant.orders" }),
		);
		const injectedTopic = {
			operation: {
				id: "v1.2000000000000.topicnonce123456",
				expiresAtMs: 2000000000000n,
			},
			message,
			topic: "tenant.audit",
		};
		expect((await topic.publish(injectedTopic)).tag).toBe("unknown");
		expect(port.publish).toHaveBeenCalledTimes(1);
		expect(
			(
				await topic.ensureSubscription({
					operation: subscriptionOperation,
					consumerGroup: "fulfillment",
					maxDeliveryAttempts: 3,
					startAt: "earliest",
				})
			).tag,
		).toBe("committed");
		expect(ensure).toHaveBeenCalledWith(
			expect.objectContaining({
				subscription: expect.objectContaining({
					topic: "tenant.orders",
					deadLetterTopic: "tenant.orders-dlq",
				}),
			}),
		);
		expect(
			(
				await topic.ensureSubscription({
					operation: otherOperation,
					consumerGroup: "other",
					maxDeliveryAttempts: 3,
					startAt: "earliest",
				})
			).tag,
		).toBe("unknown");
		expect(ensure).toHaveBeenCalledTimes(1);
		const injectedDestination = {
			operation: {
				id: "v1.2000000000000.injectnonce12345",
				expiresAtMs: 2000000000000n,
			},
			consumerGroup: "fulfillment",
			maxDeliveryAttempts: 3,
			startAt: "earliest" as const,
			deadLetterTopic: "other-dlq",
		};
		expect((await topic.ensureSubscription(injectedDestination)).tag).toBe(
			"unknown",
		);
		expect(ensure).toHaveBeenCalledTimes(1);
		expect(
			(
				await topic.consume({
					operation: {
						id: "v1.2000000000000.consumenonce1234",
						expiresAtMs: 2000000000000n,
					},
					consumerGroup: "fulfillment",
					maxMessages: 1,
					visibilityTimeoutMs: 10n,
				})
			).tag,
		).toBe("committed");
		const delivery = {
			consumerGroup: "fulfillment",
			messageId: "m",
			sequence: 1n,
			leaseId: "lease",
		};
		expect(
			(
				await topic.ack({
					...delivery,
					operation: {
						id: "v1.2000000000000.acknowledgenonce",
						expiresAtMs: 2000000000000n,
					},
				})
			).tag,
		).toBe("committed");
		expect(
			(
				await topic.nack({
					...delivery,
					reason: "retry",
					operation: {
						id: "v1.2000000000000.rejectionnonce12",
						expiresAtMs: 2000000000000n,
					},
				})
			).tag,
		).toBe("committed");
		let reads = 0;
		const malicious = {
			operation,
			get message(): typeof message {
				reads++;
				throw new Error("getter executed");
			},
		};
		expect((await topic.publish(malicious)).tag).toBe("unknown");
		expect(reads).toBe(0);
		bound.revoke();
		expect((await topic.publish({ operation, message })).tag).toBe("unknown");
	});
	it("connects a Bindle topic to independently verified messaging ports", async () => {
		const first = portFixture();
		const second = portFixture();
		let firstIsCurrent = true;
		const claims: string[] = [];
		const attach = (port: DurableMessaging) =>
			createBindleTopicWitHost(
				port,
				{ ...fixture(), bindleName: "shop" },
				{
					limitsGrant: createDurableMessagingLimitsGrant(),
					lifecycle: createDurableMessagingLifecycle(),
					verify: (claim) => {
						claims.push(`${claim.binding.resourceName}:${claim.request.phase}`);
						return (
							claim.port === port &&
							claim.bindleName === "shop" &&
							claim.applicationName === "web" &&
							claim.binding.resourceName === "orders" &&
							(port !== first || firstIsCurrent)
						);
					},
				},
			);
		const a = attach(first);
		const b = attach(second);
		expect(a.bindings).toEqual(compileBindleTopicGrants(fixture()));
		expect(Object.isFrozen(a.bindings)).toBe(true);
		const input = {
			operation: {
				id: "v1.2000000000000.abcdefghijklmnop",
				expiresAtMs: 2000000000000n,
			},
			topic: "tenant.orders",
			message: {
				id: "m1",
				subject: "created",
				payload: new Uint8Array([1]),
				attributes: [],
			},
		};
		expect((await a.host.publish(input)).tag).toBe("committed");
		expect((await b.host.publish(input)).tag).toBe("committed");
		expect(claims).toEqual([
			"orders:dispatch",
			"orders:disclose",
			"orders:dispatch",
			"orders:disclose",
		]);
		expect(
			(await a.host.publish({ ...input, topic: "tenant.audit" })).tag,
		).toBe("unknown");
		expect(first.publish).toHaveBeenCalledTimes(1);
		firstIsCurrent = false;
		expect((await a.host.publish(input)).tag).toBe("unknown");
		expect(first.publish).toHaveBeenCalledTimes(1);
		a.revoke();
		firstIsCurrent = true;
		expect((await a.host.publish(input)).tag).toBe("unknown");
		expect((await b.host.publish(input)).tag).toBe("committed");
	});
	it("compiles only the application's declared topic dependency", async () => {
		const compiled = compileBindleTopicGrants(fixture());
		expect(compiled).toEqual([
			{
				resourceName: "orders",
				grant: {
					topic: "tenant.orders",
					publish: true,
					subscriptions: [
						{
							consumerGroup: "fulfillment",
							deadLetterTopic: "tenant.orders-dlq",
						},
					],
				},
			},
		]);
		expect(Object.isFrozen(compiled[0]?.grant.subscriptions)).toBe(true);
		const policy = createDurableTopicPolicy({
			grants: compiled.map((item) => item.grant),
			verify: () => true,
		});
		expect(
			await policy.authorize({
				phase: "dispatch",
				method: "publish",
				scope: "topic",
				topic: "tenant.orders",
			}),
		).toBe(true);
		expect(
			await policy.authorize({
				phase: "dispatch",
				method: "publish",
				scope: "topic",
				topic: "audit",
			}),
		).toBe(false);
	});

	it("refuses missing, extra and unconfigured bindings", () => {
		const input = fixture();
		const binding = input.bindings[0];
		if (binding === undefined) throw new Error("missing binding");
		expect(() =>
			compileBindleTopicGrants({ ...input, bindings: [] }),
		).toThrow();
		expect(() =>
			compileBindleTopicGrants({
				...input,
				bindings: [{ ...binding, resourceName: "audit" }],
			}),
		).toThrow();
		expect(() =>
			compileBindleTopicGrants({
				...input,
				bindings: [{ ...binding, subscriptions: [] }],
			}),
		).toThrow();
	});

	it("rejects a missing dependency edge and duplicate bindings", () => {
		const input = fixture();
		expect(() => compileBindleTopicGrants({ ...input, edges: [] })).toThrow();
		expect(() =>
			compileBindleTopicGrants({
				...input,
				edges: [...input.edges, ...input.edges],
			}),
		).toThrow();
		expect(() =>
			compileBindleTopicGrants({
				...input,
				bindings: [...input.bindings, ...input.bindings],
			}),
		).toThrow();
	});

	it("rejects accessor-backed resource declarations without invoking them", () => {
		const input = fixture();
		let reads = 0;
		const resources = { ...input.resources };
		Object.defineProperty(resources, "orders", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("unexpected read");
			},
		});
		expect(() => compileBindleTopicGrants({ ...input, resources })).toThrow();
		expect(reads).toBe(0);
	});

	it("rejects distinct Bindle topics that claim the same provider topic", () => {
		const definition = bindle("shop", (builder) => {
			const orders = builder.topic().allow("publish");
			const audit = builder.topic().allow("publish");
			return { orders, audit, web: builder.web().dependsOn(orders, audit) };
		});
		expect(() =>
			compileBindleTopicGrants({
				applicationName: "web",
				resources: definition.resources,
				edges: definition.edges,
				bindings: [
					{ resourceName: "orders", topic: "shared", subscriptions: [] },
					{ resourceName: "audit", topic: "shared", subscriptions: [] },
				],
			}),
		).toThrow();
	});

	it("covers every publish and subscribe combination without granting undeclared verbs", async () => {
		for (const publish of [false, true])
			for (const subscribe of [false, true]) {
				const definition = bindle("shop", (builder) => {
					const verbs: ("publish" | "subscribe")[] = [];
					if (publish) verbs.push("publish");
					if (subscribe) verbs.push("subscribe");
					const orders = builder.topic().allow(...verbs);
					return { orders, web: builder.web().dependsOn(orders) };
				});
				const compiled = compileBindleTopicGrants({
					applicationName: "web",
					resources: definition.resources,
					edges: definition.edges,
					bindings: [
						{
							resourceName: "orders",
							topic: "orders",
							subscriptions: subscribe
								? [{ consumerGroup: "workers", deadLetterTopic: "dlq" }]
								: [],
						},
					],
				});
				const policy = createDurableTopicPolicy({
					grants: compiled.map((item) => item.grant),
					verify: () => true,
				});
				expect(
					await policy.authorize({
						phase: "dispatch",
						method: "publish",
						scope: "topic",
						topic: "orders",
					}),
				).toBe(publish);
				expect(
					await policy.authorize({
						phase: "dispatch",
						method: "consume",
						scope: "consumer-group-and-dead-letter",
						topic: "orders",
						consumerGroup: "workers",
					}),
				).toBe(subscribe);
			}
	});
});
