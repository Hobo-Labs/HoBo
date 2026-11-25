import { randomUUID } from "node:crypto";
import {
	assertDeadLetterSupported,
	type ConsumedMessage,
	createInMemoryMessaging,
	createMessagingSettlementTracker,
	createUsageEvent,
	MESSAGING_SETTLEMENT_ID_LIMIT,
	type Messaging,
	MessagingCapabilityError,
	MessagingDeliveryError,
	MessagingDeliveryExhaustedError,
	type MessagingEvent,
	type MessagingLeaseId,
	type MessagingMessageId,
	MessagingSettlementCommittedError,
	type MeteringBus,
	parseConsumerGroupId,
	parseMessagingLeaseId,
	parseMessagingMessageId,
	parseTopicName,
	type TenantId,
	type TopicName,
	tenantScopedConsumerGroup,
	tenantScopedTopicName,
} from "@hobo/core";
import type { DaprSidecarClient } from "./dapr-client.js";
import { cloneAsJson } from "./json.js";
import type { DaprRuntimeConfig } from "./types.js";

export interface DaprMessagingOptions {
	readonly config: DaprRuntimeConfig;
	readonly metering?: MeteringBus;
	readonly live?: boolean;
	readonly client?: DaprSidecarClient;
	readonly now?: () => string;
	readonly settlementTimeoutMs?: number;
}

export interface DaprMessaging extends Messaging {
	readonly pubsubName: string;
	readonly fidelity: "simulated" | "live";
	readonly placement: "dapr-pubsub";
	readonly client: DaprSidecarClient | null;
}

export function createDaprMessaging(
	options: DaprMessagingOptions,
): DaprMessaging {
	const { config } = options;
	if (options.live === true && !options.client) {
		throw new MessagingCapabilityError(
			"createDaprMessaging: live fidelity requires a DaprSidecarClient",
		);
	}

	const client = options.client ?? null;
	const capabilities = {
		deliveryGuarantees: ["at-least-once", "at-most-once"] as const,
		consumerGroups: true,
		transactionalProduce: false,
		idempotentProduce: false,
		schemaRegistry: false,
		deadLetter: false,
		partitionAware: false,
		crossYardFederation: true,
	};
	const pending = createMessagingSettlementTracker<{
		topic: TopicName;
		group: string;
	}>(options.settlementTimeoutMs);

	if (!client) {
		const inner = createInMemoryMessaging({
			tenantId: config.tenantId,
			capabilities: { ...capabilities },
			...(options.now ? { now: options.now } : undefined),
		});
		const simulated: DaprMessaging = {
			backend: "dapr-pubsub",
			capabilities: inner.capabilities,
			pubsubName: config.defaultPubsubName,
			fidelity: "simulated",
			placement: "dapr-pubsub",
			client: null,
			ensureTopic: (spec) => inner.ensureTopic(spec),
			ensureSubscription: (spec) => inner.ensureSubscription(spec),
			async publish(topic, body, publishOptions) {
				const result = await inner.publish(topic, body, publishOptions);
				await meter(
					options.metering,
					config,
					"messaging.publish",
					topic,
					1,
					"simulated",
				);
				return result;
			},
			async consume(topic, group, opts) {
				const batch = await inner.consume(topic, group, opts);
				await meter(
					options.metering,
					config,
					"messaging.consume",
					topic,
					batch.length,
					"simulated",
				);
				return batch;
			},
			subscribe: (t, g, h, o) => inner.subscribe(t, g, h, o),
			ack: (m, l) => inner.ack(m, l),
			nack: (m, l, r) => inner.nack(m, l, r),
			events: () => inner.events(),
		};
		return Object.freeze(simulated);
	}

	const eventLog: MessagingEvent[] = [];
	const leasePrefix = randomUUID();
	let leaseSequence = 0;
	const subscriptions = new Map<
		string,
		{ topic: string; group: string; maxDeliveryAttempts: number }
	>();
	const tenantId = config.tenantId as TenantId;
	const now = options.now ?? (() => new Date().toISOString());
	const emit = (
		partial: Omit<MessagingEvent, "at" | "tenantId"> & {
			tenantId?: TenantId;
		},
	) => {
		eventLog.push(
			Object.freeze({
				...partial,
				tenantId: partial.tenantId ?? tenantId,
				at: now(),
			}),
		);
	};

	const live: DaprMessaging = {
		backend: "dapr-pubsub",
		capabilities: { ...capabilities },
		pubsubName: config.defaultPubsubName,
		fidelity: "live",
		placement: "dapr-pubsub",
		client,

		async ensureTopic(spec) {
			assertDeadLetterSupported(capabilities, spec);
			const name = tenantScopedTopicName(spec.tenantId, spec.name);
			emit({ type: "messaging.topic.created", topic: name });
			return Object.freeze({ ...spec, name });
		},

		async ensureSubscription(spec) {
			assertDeadLetterSupported(capabilities, spec);
			const topic = tenantScopedTopicName(spec.tenantId, spec.topic);
			const group = tenantScopedConsumerGroup(
				spec.tenantId,
				spec.consumerGroup,
			);
			const maxDeliveryAttempts = spec.maxDeliveryAttempts ?? 5;
			subscriptions.set(`${topic}::${group}`, {
				topic,
				group,
				maxDeliveryAttempts,
			});
			emit({
				type: "messaging.subscription.created",
				topic,
				consumerGroup: group,
			});
			return Object.freeze({
				...spec,
				topic,
				consumerGroup: group,
				maxDeliveryAttempts,
			});
		},

		async publish(topic, body, publishOptions) {
			const physical = tenantScopedTopicName(tenantId, topic);
			const { id } = await client.publish({
				pubsubName: config.defaultPubsubName,
				topic: physical,
				data: cloneAsJson(body),
				metadata: {
					...publishOptions?.headers,
					...(publishOptions?.key
						? { partitionKey: publishOptions.key }
						: undefined),
				},
			});
			const messageId = parseMessagingMessageId(id);
			emit({
				type: "messaging.published",
				topic: physical,
				messageId,
			});
			await meter(
				options.metering,
				config,
				"messaging.publish",
				topic,
				1,
				"live",
			);
			return Object.freeze({
				messageId,
				topic: physical,
				partitionKey: publishOptions?.key ?? "",
				offset: 0,
				publishedAt: now(),
				deduped: false,
			});
		},

		async consume(topic, consumerGroup, opts = {}) {
			const physical = tenantScopedTopicName(tenantId, topic);
			const group = tenantScopedConsumerGroup(tenantId, consumerGroup);
			if (
				physical.length > MESSAGING_SETTLEMENT_ID_LIMIT ||
				group.length > MESSAGING_SETTLEMENT_ID_LIMIT
			)
				throw new MessagingDeliveryError("messaging scope is not bounded");
			const maxMessages = opts.maxMessages ?? 1;
			if (
				!Number.isSafeInteger(maxMessages) ||
				maxMessages < 1 ||
				maxMessages > pending.capacity()
			)
				throw new MessagingDeliveryError(
					"invalid or unavailable messaging capacity",
				);
			const drained = await client.drain(
				config.defaultPubsubName,
				physical,
				maxMessages,
				group,
			);
			if (drained.length > maxMessages)
				throw new MessagingDeliveryError("sidecar returned too many messages");
			const claims: {
				messageId: MessagingMessageId;
				leaseId: MessagingLeaseId;
				scope: string;
				context: { topic: TopicName; group: string };
			}[] = [];
			const batch: ConsumedMessage[] = drained.map((m) => {
				const messageId = parseMessagingMessageId(m.id);
				if (messageId.length > MESSAGING_SETTLEMENT_ID_LIMIT)
					throw new MessagingDeliveryError(
						"messaging lease identity is not bounded",
					);
				if (leaseSequence >= Number.MAX_SAFE_INTEGER)
					throw new MessagingDeliveryError(
						"messaging lease sequence exhausted",
					);
				const leaseId = parseMessagingLeaseId(
					`dapr-${leasePrefix}-${++leaseSequence}`,
				);
				claims.push({
					messageId,
					leaseId,
					scope: JSON.stringify([physical, group, messageId]),
					context: { topic: physical, group },
				});
				return Object.freeze({
					messageId,
					topic: parseTopicName(m.topic),
					consumerGroup: parseConsumerGroupId(group),
					body: m.data,
					deliveryAttempt: m.deliveryAttempt,
					leaseId,
					receivedAt: now(),
					headers: {},
				});
			});
			pending.register(claims);
			for (const m of batch) {
				emit({
					type: "messaging.consumed",
					topic: physical,
					messageId: m.messageId,
					consumerGroup: group,
				});
			}
			await meter(
				options.metering,
				config,
				"messaging.consume",
				topic,
				batch.length,
				"live",
			);
			return batch;
		},

		async subscribe(topic, consumerGroup, handler, opts = {}) {
			const physical = tenantScopedTopicName(tenantId, topic);
			const group = tenantScopedConsumerGroup(tenantId, consumerGroup);
			const sub = subscriptions.get(`${physical}::${group}`);
			const maxAttempts = sub?.maxDeliveryAttempts ?? 5;
			const batch = await live.consume(topic, consumerGroup, {
				maxMessages: opts.maxMessages ?? 32,
				...opts,
			});
			let handled = 0;
			for (const [index, message] of batch.entries()) {
				const exhausted = (): never => {
					emit({
						type: "messaging.delivery.exhausted",
						topic: message.topic,
						messageId: message.messageId,
						consumerGroup: group,
						reason: "max_delivery_attempts",
					});
					throw new MessagingDeliveryExhaustedError(
						message,
						Object.freeze(batch.slice(index + 1)),
						handled,
					);
				};
				if (message.deliveryAttempt > maxAttempts) exhausted();
				try {
					await handler(message);
				} catch (err) {
					if (message.deliveryAttempt >= maxAttempts) exhausted();
					await live.nack(
						message.messageId,
						message.leaseId,
						err instanceof Error ? err.message : String(err),
					);
					continue;
				}
				await live.ack(message.messageId, message.leaseId);
				handled += 1;
			}
			return { handled, deadLettered: 0 };
		},

		async ack(messageId, leaseId) {
			const id = parseMessagingMessageId(String(messageId));
			const lease = parseMessagingLeaseId(String(leaseId));
			const context = await pending.settle(id, lease, "ack", (value) =>
				client.ack(String(id), value.group),
			);
			try {
				emit({ type: "messaging.acked", topic: context.topic, messageId: id });
			} catch {
				throw new MessagingSettlementCommittedError("ack", id, lease);
			}
		},

		async nack(messageId, leaseId, reason) {
			const id = parseMessagingMessageId(String(messageId));
			const lease = parseMessagingLeaseId(String(leaseId));
			const context = await pending.settle(id, lease, "nack", (value) =>
				client.nack(String(id), value.group),
			);
			try {
				emit({
					type: "messaging.nacked",
					topic: context.topic,
					messageId: id,
					reason: reason ?? "nack",
				});
			} catch {
				throw new MessagingSettlementCommittedError("nack", id, lease);
			}
		},

		events() {
			return eventLog.slice();
		},
	};

	return Object.freeze(live);
}

async function meter(
	metering: MeteringBus | undefined,
	config: DaprRuntimeConfig,
	eventType: "messaging.publish" | "messaging.consume",
	topic: TopicName | string,
	quantity: number,
	fidelity: "simulated" | "live",
): Promise<void> {
	if (!metering || quantity === 0) return;
	await metering.emit(
		createUsageEvent({
			tenantId: config.tenantId as TenantId,
			eventType,
			resource: tenantScopedTopicName(config.tenantId, String(topic)),
			quantity,
			unit: "message",
			metadata: {
				backend: "dapr-pubsub",
				pubsub: config.defaultPubsubName,
				appId: config.appId,
				fidelity,
			},
		}),
	);
}
