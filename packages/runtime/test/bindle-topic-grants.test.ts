import { describe, expect, it } from "vitest";
import { bindle } from "../../bindles/src/bindle.js";
import {
	compileBindleTopicGrants,
	createDurableTopicPolicy,
} from "../src/durable-messaging-host.js";

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
