import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

import {
	assertDeliverySupported,
	MessagingCapabilityError,
	MessagingParseError,
	parseActorPlacementMode,
	parseDeliveryGuarantee,
	parseMessagingSpec,
	parseSubscriptionSpec,
	parseTopicName,
	parseTopicSpec,
	tenantScopedConsumerGroup,
	tenantScopedTopicName,
} from "../src/ports/messaging.js";

describe("branded id parsing", () => {
	it("accepts a non-empty topic name", () => {
		expect(parseTopicName("orders")).toBe("orders");
	});

	it.each(["", null, undefined, 7])("rejects the topic name %s", (value) => {
		expect(() => parseTopicName(value as string)).toThrow(MessagingParseError);
	});
});

describe("parseDeliveryGuarantee", () => {
	it.each([
		"at-least-once",
		"exactly-once",
		"at-most-once",
	])("accepts %s", (value) => {
		expect(parseDeliveryGuarantee(value)).toBe(value);
	});

	it.each([
		"once",
		"AT-LEAST-ONCE",
		"",
		null,
		undefined,
		1,
	])("rejects %s", (value) => {
		expect(() => parseDeliveryGuarantee(value)).toThrow(MessagingParseError);
	});

	it("names the permitted values in the error", () => {
		expect(() => parseDeliveryGuarantee("once")).toThrow(/at-least-once/u);
	});
});

describe("parseActorPlacementMode", () => {
	it.each(["native", "dapr", "rivet", "celld"])("accepts %s", (value) => {
		expect(parseActorPlacementMode(value)).toBe(value);
	});

	it.each(["kubernetes", "", null, 7])("rejects %s", (value) => {
		expect(() => parseActorPlacementMode(value)).toThrow(MessagingParseError);
	});
});

describe("tenant scoping", () => {
	it("prefixes an unscoped topic", () => {
		expect(tenantScopedTopicName("t1", "orders")).toBe("t1.orders");
	});

	it("does not double-prefix a dot-scoped name", () => {
		expect(tenantScopedTopicName("t1", "t1.orders")).toBe("t1.orders");
	});

	it("does not double-prefix a slash-scoped name", () => {
		expect(tenantScopedTopicName("t1", "t1/orders")).toBe("t1/orders");
	});

	it("is idempotent across repeated application", () => {
		const once = tenantScopedTopicName("t1", "orders");
		expect(tenantScopedTopicName("t1", once)).toBe(once);
	});

	it("still prefixes a name that merely starts with the tenant text", () => {
		expect(tenantScopedTopicName("t1", "t1x-orders")).toBe("t1.t1x-orders");
	});

	it("prefixes for a different tenant's already-scoped name", () => {
		expect(tenantScopedTopicName("t2", "t1.orders")).toBe("t2.t1.orders");
	});

	it.each(["", null, undefined])("rejects the tenant %s", (tenant) => {
		expect(() => tenantScopedTopicName(tenant as string, "orders")).toThrow(
			MessagingParseError,
		);
	});

	it("rejects an empty topic", () => {
		expect(() => tenantScopedTopicName("t1", "")).toThrow(MessagingParseError);
	});

	it("applies the same rules to consumer groups", () => {
		expect(tenantScopedConsumerGroup("t1", "workers")).toBe("t1.workers");
		expect(tenantScopedConsumerGroup("t1", "t1.workers")).toBe("t1.workers");
		expect(tenantScopedConsumerGroup("t1", "t1/workers")).toBe("t1/workers");
	});

	it("rejects an empty consumer group", () => {
		expect(() => tenantScopedConsumerGroup("t1", "")).toThrow(
			MessagingParseError,
		);
	});
});

describe("parseTopicSpec", () => {
	const topic = (overrides: JsonObject = {}) => ({
		name: "orders",
		tenantId: "t1",
		...overrides,
	});

	it("parses a minimal spec", () => {
		expect(parseTopicSpec(topic())).toMatchObject({
			name: "orders",
			tenantId: "t1",
		});
	});

	it("defaults delivery to at-least-once", () => {
		expect(parseTopicSpec(topic()).delivery).toBe("at-least-once");
	});

	it("keeps an explicit delivery guarantee", () => {
		expect(parseTopicSpec(topic({ delivery: "exactly-once" })).delivery).toBe(
			"exactly-once",
		);
	});

	it("rejects an unknown delivery guarantee", () => {
		expect(() => parseTopicSpec(topic({ delivery: "maybe" }))).toThrow(
			MessagingParseError,
		);
	});

	it.each([
		null,
		undefined,
		"orders",
		7,
	])("rejects the non-object %s", (raw) => {
		expect(() => parseTopicSpec(raw)).toThrow(MessagingParseError);
	});

	it("requires a name", () => {
		expect(() => parseTopicSpec({ tenantId: "t1" })).toThrow(
			MessagingParseError,
		);
	});

	it("requires a tenant", () => {
		expect(() => parseTopicSpec({ name: "orders" })).toThrow(
			MessagingParseError,
		);
	});

	it("accepts tenant_id as the snake_case spelling", () => {
		expect(parseTopicSpec({ name: "orders", tenant_id: "t1" }).tenantId).toBe(
			"t1",
		);
	});

	it.each([
		["projectId", "project_id"],
		["deadLetterTopic", "dead_letter_topic"],
		["schemaRef", "schema_ref"],
	])("reads %s and its snake_case spelling %s", (camel, snake) => {
		expect(parseTopicSpec(topic({ [camel]: "v" }))).toMatchObject({
			[camel]: "v",
		});
		expect(parseTopicSpec(topic({ [snake]: "v" }))).toMatchObject({
			[camel]: "v",
		});
	});

	it("omits optional fields rather than setting them undefined", () => {
		const parsed = parseTopicSpec(topic());
		expect(parsed).not.toHaveProperty("projectId");
		expect(parsed).not.toHaveProperty("deadLetterTopic");
		expect(parsed).not.toHaveProperty("schemaRef");
		expect(parsed).not.toHaveProperty("labels");
	});

	it("copies labels rather than aliasing the caller's object", () => {
		const labels = { team: "core" };
		const parsed = parseTopicSpec(topic({ labels }));
		labels.team = "other";
		expect(parsed.labels).toEqual({ team: "core" });
	});

	it("ignores a non-object labels field", () => {
		expect(parseTopicSpec(topic({ labels: "team=core" }))).not.toHaveProperty(
			"labels",
		);
	});

	it("freezes the spec", () => {
		expect(Object.isFrozen(parseTopicSpec(topic()))).toBe(true);
	});
});

describe("parseSubscriptionSpec", () => {
	const subscription = (overrides: JsonObject = {}) => ({
		name: "sub",
		topic: "orders",
		consumerGroup: "workers",
		tenantId: "t1",
		...overrides,
	});

	it("parses a minimal spec", () => {
		expect(parseSubscriptionSpec(subscription())).toMatchObject({
			name: "sub",
			topic: "orders",
			consumerGroup: "workers",
		});
	});

	it("defaults max delivery attempts rather than leaving redelivery unbounded", () => {
		expect(parseSubscriptionSpec(subscription()).maxDeliveryAttempts).toBe(5);
	});

	it("keeps an explicit attempt limit", () => {
		expect(
			parseSubscriptionSpec(subscription({ maxDeliveryAttempts: 3 }))
				.maxDeliveryAttempts,
		).toBe(3);
	});

	it("accepts the snake_case attempt limit", () => {
		expect(
			parseSubscriptionSpec(subscription({ max_delivery_attempts: 2 }))
				.maxDeliveryAttempts,
		).toBe(2);
	});

	it.each([0, -1, 1.5])("rejects the attempt limit %s", (value) => {
		expect(() =>
			parseSubscriptionSpec(subscription({ maxDeliveryAttempts: value })),
		).toThrow(MessagingParseError);
	});

	it("requires a consumer group", () => {
		expect(() =>
			parseSubscriptionSpec({ name: "s", topic: "t", tenantId: "t1" }),
		).toThrow(MessagingParseError);
	});

	it("accepts consumer_group as the snake_case spelling", () => {
		expect(
			parseSubscriptionSpec({
				name: "s",
				topic: "t",
				consumer_group: "workers",
				tenantId: "t1",
			}).consumerGroup,
		).toBe("workers");
	});

	it("carries a dead-letter topic under either spelling", () => {
		expect(
			parseSubscriptionSpec(subscription({ deadLetterTopic: "dlq" }))
				.deadLetterTopic,
		).toBe("dlq");
		expect(
			parseSubscriptionSpec(subscription({ dead_letter_topic: "dlq" }))
				.deadLetterTopic,
		).toBe("dlq");
	});

	it.each([null, undefined, "sub", 7])("rejects the non-object %s", (raw) => {
		expect(() => parseSubscriptionSpec(raw)).toThrow(MessagingParseError);
	});

	it("freezes the spec", () => {
		expect(Object.isFrozen(parseSubscriptionSpec(subscription()))).toBe(true);
	});
});

describe("parseMessagingSpec", () => {
	const spec = (overrides: JsonObject = {}) => ({
		id: "m1",
		tenantId: "t1",
		...overrides,
	});

	it("parses a minimal spec", () => {
		expect(parseMessagingSpec(spec())).toMatchObject({ id: "m1" });
	});

	it("defaults the backend to local-memory", () => {
		expect(parseMessagingSpec(spec()).backend).toBe("local-memory");
	});

	it("defaults topics and subscriptions to empty", () => {
		const parsed = parseMessagingSpec(spec());
		expect(parsed.topics).toEqual([]);
		expect(parsed.subscriptions).toEqual([]);
	});

	it("treats a non-array topics field as empty", () => {
		expect(parseMessagingSpec(spec({ topics: "orders" })).topics).toEqual([]);
	});

	it("parses nested topics and subscriptions", () => {
		const parsed = parseMessagingSpec(
			spec({
				topics: [{ name: "orders", tenantId: "t1" }],
				subscriptions: [
					{
						name: "sub",
						topic: "orders",
						consumerGroup: "workers",
						tenantId: "t1",
					},
				],
			}),
		);
		expect(parsed.topics).toHaveLength(1);
		expect(parsed.subscriptions).toHaveLength(1);
	});

	it("propagates a nested parse failure rather than dropping the entry", () => {
		expect(() =>
			parseMessagingSpec(spec({ topics: [{ tenantId: "t1" }] })),
		).toThrow(MessagingParseError);
	});

	it("requires an id and a tenant", () => {
		expect(() => parseMessagingSpec({ tenantId: "t1" })).toThrow(
			MessagingParseError,
		);
		expect(() => parseMessagingSpec({ id: "m1" })).toThrow(MessagingParseError);
	});

	it.each([null, undefined, "spec", 7])("rejects the non-object %s", (raw) => {
		expect(() => parseMessagingSpec(raw)).toThrow(MessagingParseError);
	});
});

describe("assertDeliverySupported", () => {
	const capabilities = {
		deliveryGuarantees: ["at-least-once", "at-most-once"],
	} as never;

	it("permits a supported guarantee", () => {
		expect(() =>
			assertDeliverySupported(capabilities, "at-least-once"),
		).not.toThrow();
	});

	it("refuses an unsupported one", () => {
		expect(() => assertDeliverySupported(capabilities, "exactly-once")).toThrow(
			MessagingCapabilityError,
		);
	});

	it("lists what the backend does support, so the fix is visible", () => {
		expect(() => assertDeliverySupported(capabilities, "exactly-once")).toThrow(
			/supports: at-least-once, at-most-once/u,
		);
	});

	it("refuses everything when the backend supports nothing", () => {
		expect(() =>
			assertDeliverySupported(
				{ deliveryGuarantees: [] } as never,
				"at-least-once",
			),
		).toThrow(MessagingCapabilityError);
	});
});
