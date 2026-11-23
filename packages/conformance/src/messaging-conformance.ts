import type { Messaging } from "@hobo/core";
import {
	assertDeliverySupported,
	MessagingCapabilityError,
	parseConsumerGroupId,
	parseTopicName,
	type TenantId,
} from "@hobo/core";
import { first } from "@hobo/core/total-access";

// public-contract: schema version of the messaging conformance suite definition.
export const MESSAGING_CONFORMANCE_CONTRACT = "hobo.messaging-conformance/v1";

export type MessagingAssertionName =
	| "publishConsumeAck"
	| "consumerGroupIsolation"
	| "deadLetterMaxAttempts"
	| "exactlyOnceCapabilityGate";

export type MessagingConformanceReport = {
	readonly contract: typeof MESSAGING_CONFORMANCE_CONTRACT;
	readonly backend: string;
	readonly assertions: Record<MessagingAssertionName, "pass" | "fail">;
};

export type CreateMessagingFn = () => Messaging | Promise<Messaging>;

export async function runMessagingConformance(
	createMessaging: CreateMessagingFn,
	options: { backend?: string } = {},
): Promise<MessagingConformanceReport> {
	if (!(createMessaging instanceof Function)) {
		throw new TypeError("createMessaging must be a function");
	}

	const assertions = {} as Record<MessagingAssertionName, "pass" | "fail">;

	const run = async (
		name: MessagingAssertionName,
		fn: () => boolean | Promise<boolean>,
	) => {
		try {
			assertions[name] = (await fn()) ? "pass" : "fail";
		} catch {
			assertions[name] = "fail";
		}
	};

	await run("publishConsumeAck", () =>
		provesPublishConsumeAck(createMessaging),
	);
	await run("consumerGroupIsolation", () =>
		provesConsumerGroupIsolation(createMessaging),
	);
	await run("deadLetterMaxAttempts", () =>
		provesDeadLetterMaxAttempts(createMessaging),
	);
	await run("exactlyOnceCapabilityGate", () =>
		provesExactlyOnceCapabilityGate(createMessaging),
	);

	return {
		contract: MESSAGING_CONFORMANCE_CONTRACT,
		backend: options.backend ?? "anonymous",
		assertions,
	};
}

async function provesPublishConsumeAck(
	create: CreateMessagingFn,
): Promise<boolean> {
	const bus = await create();
	const topic = parseTopicName("conf-orders");
	await bus.ensureTopic({
		name: topic,
		tenantId: "conf" as TenantId,
		delivery: "at-least-once",
	});
	await bus.publish(topic, { n: 1 });
	const batch = await bus.consume(topic, parseConsumerGroupId("cg"), {
		maxMessages: 5,
	});
	if (batch.length < 1) return false;
	bus.ack(first(batch).messageId, first(batch).leaseId);
	const flushable = bus as Messaging & { flush?: () => Promise<void> };
	if (flushable.flush instanceof Function) {
		await flushable.flush();
	}
	const again = await bus.consume(topic, parseConsumerGroupId("cg"));
	return again.length === 0;
}

async function provesConsumerGroupIsolation(
	create: CreateMessagingFn,
): Promise<boolean> {
	const bus = await create();
	const topic = parseTopicName("conf-iso");
	await bus.publish(topic, { iso: true });
	const g1 = await bus.consume(topic, parseConsumerGroupId("g1"));
	const g2 = await bus.consume(topic, parseConsumerGroupId("g2"));
	return g1.length >= 1 && g2.length >= 1;
}

async function provesDeadLetterMaxAttempts(
	create: CreateMessagingFn,
): Promise<boolean> {
	const bus = await create();
	const topic = parseTopicName("conf-dlq");
	await bus.ensureSubscription({
		name: "s" as never,
		topic,
		consumerGroup: parseConsumerGroupId("dlq"),
		tenantId: "conf" as TenantId,
		delivery: "at-least-once",
		maxDeliveryAttempts: 2,
	});
	await bus.publish(topic, { fail: true });
	await bus.subscribe(topic, parseConsumerGroupId("dlq"), async () => {
		throw new Error("boom");
	});
	const r2 = await bus.subscribe(
		topic,
		parseConsumerGroupId("dlq"),
		async () => {
			throw new Error("boom");
		},
	);
	return r2.deadLettered >= 1;
}

async function provesExactlyOnceCapabilityGate(
	create: CreateMessagingFn,
): Promise<boolean> {
	const bus = await create();
	try {
		assertDeliverySupported(bus.capabilities, "exactly-once");
		await bus.publish(
			parseTopicName("conf-xo"),
			{ x: 1 },
			{
				delivery: "exactly-once",
			},
		);
		return true;
	} catch (err) {
		if (err instanceof MessagingCapabilityError) {
			return !bus.capabilities.deliveryGuarantees.includes("exactly-once");
		}
		return false;
	}
}
