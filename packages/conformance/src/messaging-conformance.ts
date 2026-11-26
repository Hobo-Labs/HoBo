import type { Messaging } from "@hobo/core";
import {
	assertDeliverySupported,
	MessagingCapabilityError,
	MessagingDeliveryExhaustedError,
	parseConsumerGroupId,
	parseTopicName,
	type TenantId,
} from "@hobo/core";
import { first } from "@hobo/core/total-access";

export const MESSAGING_CONFORMANCE_CONTRACT = "hobo.messaging-conformance/v1";

export type MessagingAssertionName =
	| "publishConsumeAck"
	| "consumerGroupIsolation"
	| "deadLetterMaxAttempts"
	| "exactlyOnceCapabilityGate";

export type MessagingConformanceReport = {
	readonly contract: typeof MESSAGING_CONFORMANCE_CONTRACT;
	readonly backend: string;
	readonly assertions: Record<
		MessagingAssertionName,
		"pass" | "fail" | "unsupported"
	>;
};

export type CreateMessagingFn = () => Messaging | Promise<Messaging>;

export async function runMessagingConformance(
	createMessaging: CreateMessagingFn,
	options: { backend?: string } = {},
): Promise<MessagingConformanceReport> {
	if (!(createMessaging instanceof Function)) {
		throw new TypeError("createMessaging must be a function");
	}

	const assertions = {} as Record<
		MessagingAssertionName,
		"pass" | "fail" | "unsupported"
	>;

	const run = async (
		name: MessagingAssertionName,
		fn: () => boolean | "unsupported" | Promise<boolean | "unsupported">,
	) => {
		try {
			const result = await fn();
			assertions[name] =
				result === "unsupported" ? result : result ? "pass" : "fail";
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
	await bus.ack(first(batch).messageId, first(batch).leaseId);
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
): Promise<boolean | "unsupported"> {
	const bus = await create();
	const topic = parseTopicName("conf-dlq");
	const deadLetterTopic = parseTopicName("conf-dead");
	const subscription = {
		name: "s" as never,
		topic,
		consumerGroup: parseConsumerGroupId("dlq"),
		tenantId: "conf" as TenantId,
		delivery: "at-least-once" as const,
		maxDeliveryAttempts: 2,
	};
	if (!bus.capabilities.deadLetter) {
		try {
			await bus.ensureTopic({
				name: topic,
				tenantId: subscription.tenantId,
				delivery: "at-least-once",
				deadLetterTopic,
			});
			return false;
		} catch (error) {
			if (!(error instanceof MessagingCapabilityError)) return false;
		}
		try {
			await bus.ensureSubscription({ ...subscription, deadLetterTopic });
			return false;
		} catch (error) {
			if (!(error instanceof MessagingCapabilityError)) return false;
		}
		if (bus.events().length !== 0) return false;
	} else {
		await bus.ensureTopic({
			name: deadLetterTopic,
			tenantId: subscription.tenantId,
			delivery: "at-least-once",
		});
	}
	await bus.ensureSubscription(
		bus.capabilities.deadLetter
			? { ...subscription, deadLetterTopic }
			: subscription,
	);
	await bus.publish(topic, { fail: true });
	await bus.subscribe(topic, parseConsumerGroupId("dlq"), async () => {
		throw new Error("boom");
	});
	try {
		const result = await bus.subscribe(
			topic,
			parseConsumerGroupId("dlq"),
			async () => {
				throw new Error("boom");
			},
		);
		if (!bus.capabilities.deadLetter || result.deadLettered !== 1) return false;
		const dead = await bus.consume(
			deadLetterTopic,
			parseConsumerGroupId("reader"),
		);
		return (
			dead.length === 1 &&
			JSON.stringify(dead[0]?.body) === JSON.stringify({ fail: true })
		);
	} catch (error) {
		if (
			bus.capabilities.deadLetter ||
			!(error instanceof MessagingDeliveryExhaustedError)
		)
			return false;
		if (bus.events().some((event) => event.type === "messaging.dead_lettered"))
			return false;
		await bus.nack(error.delivery.messageId, error.delivery.leaseId);
		const replay = await bus.consume(topic, parseConsumerGroupId("dlq"));
		return replay.some(
			(message) => message.messageId === error.delivery.messageId,
		)
			? "unsupported"
			: false;
	}
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
