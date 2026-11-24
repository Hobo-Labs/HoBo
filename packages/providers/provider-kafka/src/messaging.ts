import { randomUUID } from "node:crypto";
import {
	assertDeadLetterSupported,
	type ConsumedMessage,
	type ConsumerGroupId,
	createInMemoryMessaging,
	createMessagingSettlementTracker,
	createUsageEvent,
	type DeliveryGuarantee,
	MESSAGING_SETTLEMENT_ID_LIMIT,
	type Messaging,
	type MessagingCapabilities,
	MessagingCapabilityError,
	MessagingDeliveryError,
	MessagingDeliveryExhaustedError,
	type MessagingEvent,
	type MessagingLeaseId,
	type MessagingMessageId,
	MessagingSettlementCommittedError,
	type MeteringBus,
	type PublishOptions,
	type PublishResult,
	parseConsumerGroupId,
	parseMessagingLeaseId,
	parseMessagingMessageId,
	parseTenantId,
	type SubscriptionSpec,
	type TenantId,
	type TopicName,
	type TopicSpec,
	tenantScopedConsumerGroup,
	tenantScopedTopicName,
} from "@hobo/core";

import type { KafkaBrokerTransport } from "./transport.js";
import {
	KAFKA_MESSAGING_CAPABILITIES,
	type KafkaClusterSpec,
} from "./types.js";

export interface KafkaMessagingOptions {
	readonly cluster: KafkaClusterSpec;
	readonly metering?: MeteringBus;
	readonly live?: boolean;
	readonly transport?: KafkaBrokerTransport;
	readonly now?: () => string;
	readonly settlementTimeoutMs?: number;
}

export interface KafkaMessaging extends Messaging {
	readonly cluster: KafkaClusterSpec;
	readonly fidelity: "simulated" | "live";
	readonly transport: KafkaBrokerTransport | null;
	readonly partitionsFor: (topic: TopicName) => number;
}

export function createKafkaMessaging(
	options: KafkaMessagingOptions,
): KafkaMessaging {
	const { cluster } = options;
	if (options.live === true && !options.transport) {
		throw new MessagingCapabilityError(
			"createKafkaMessaging: live fidelity requires a KafkaBrokerTransport (fake harness or real broker client)",
		);
	}

	const transport = options.transport ?? null;
	const capabilities: MessagingCapabilities = {
		...KAFKA_MESSAGING_CAPABILITIES,
		transactionalProduce: cluster.transactional,
		idempotentProduce: cluster.idempotentProducer,
		schemaRegistry: Boolean(cluster.schemaRegistryRef),
	};

	const partitionMap = new Map<string, number>();
	const pendingCommits = createMessagingSettlementTracker<{
		topic: TopicName;
		group: string;
		backendLease: string;
	}>(options.settlementTimeoutMs);

	if (!transport) {
		const inner = createInMemoryMessaging({
			tenantId: cluster.tenantId,
			capabilities,
			...(options.now ? { now: options.now } : undefined),
		});
		const simulated: KafkaMessaging = {
			backend: "native-kafka",
			capabilities,
			cluster,
			fidelity: "simulated" as const,
			transport: null,
			partitionsFor(topic: TopicName) {
				return partitionMap.get(topic) ?? 1;
			},
			async ensureTopic(spec: TopicSpec) {
				const ensured = await inner.ensureTopic(spec);
				partitionMap.set(ensured.name, partitionMap.get(ensured.name) ?? 3);
				return ensured;
			},
			ensureSubscription: (spec: SubscriptionSpec) =>
				inner.ensureSubscription(spec),
			async publish(topic, body, publishOptions) {
				return publishViaInner(
					inner,
					cluster,
					topic,
					body,
					publishOptions,
					options.metering,
					"simulated",
				);
			},
			async consume(
				topic: TopicName,
				group: ConsumerGroupId,
				consumeOptions?: { maxMessages?: number; visibilityTimeoutMs?: number },
			) {
				const batch = await inner.consume(topic, group, consumeOptions);
				await meterConsume(
					options.metering,
					cluster,
					topic,
					group,
					batch.length,
					"simulated",
				);
				return batch;
			},
			subscribe: (
				topic: TopicName,
				group: ConsumerGroupId,
				handler: (message: ConsumedMessage) => Promise<void>,
				opts?: { maxMessages?: number; visibilityTimeoutMs?: number },
			) => inner.subscribe(topic, group, handler, opts),
			ack: (id: MessagingMessageId, lease: MessagingLeaseId) =>
				inner.ack(id, lease),
			nack: (
				id: MessagingMessageId,
				lease: MessagingLeaseId,
				reason?: string,
			) => inner.nack(id, lease, reason),
			events: () => inner.events(),
		};
		return Object.freeze(simulated);
	}

	const eventLog: MessagingEvent[] = [];
	const leasePrefix = randomUUID();
	let leaseSequence = 0;
	const subscriptions = new Map<string, SubscriptionSpec>();
	const tenantId = parseTenantId(cluster.tenantId);
	const now = options.now ?? (() => new Date().toISOString());

	const emitLocal = (
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

	const live: KafkaMessaging = {
		backend: "native-kafka",
		capabilities,
		cluster,
		fidelity: "live",
		transport,
		partitionsFor(topic) {
			return partitionMap.get(topic) ?? 3;
		},

		async ensureTopic(spec) {
			assertDeadLetterSupported(capabilities, spec);
			const scoped: TopicSpec = Object.freeze({
				...spec,
				name: tenantScopedTopicName(spec.tenantId, spec.name),
			});
			await transport.ensureTopic(scoped.name, { partitions: 3 });
			partitionMap.set(scoped.name, 3);
			emitLocal({ type: "messaging.topic.created", topic: scoped.name });
			return scoped;
		},

		async ensureSubscription(spec) {
			assertDeadLetterSupported(capabilities, spec);
			const topic = tenantScopedTopicName(spec.tenantId, spec.topic);
			const group = tenantScopedConsumerGroup(
				spec.tenantId,
				spec.consumerGroup,
			);
			await transport.ensureTopic(topic);
			const scoped: SubscriptionSpec = Object.freeze({
				...spec,
				topic,
				consumerGroup: group,
			});
			subscriptions.set(`${scoped.name}::${topic}::${group}`, scoped);
			emitLocal({
				type: "messaging.subscription.created",
				topic,
				consumerGroup: group,
			});
			return scoped;
		},

		async publish(topic, body, publishOptions = {}) {
			const delivery: DeliveryGuarantee =
				publishOptions.delivery ??
				(cluster.transactional ? "exactly-once" : "at-least-once");
			if (!capabilities.deliveryGuarantees.includes(delivery)) {
				throw new MessagingCapabilityError(
					`backend does not support delivery guarantee '${delivery}'`,
				);
			}
			const physical = tenantScopedTopicName(tenantId, topic);
			await transport.ensureTopic(physical);
			const produced = await transport.produce({
				topic: physical,
				key: publishOptions.key ?? "",
				body,
				headers: { ...publishOptions.headers },
				...(publishOptions.idempotencyKey
					? { idempotencyKey: publishOptions.idempotencyKey }
					: undefined),
			});
			const result: PublishResult = Object.freeze({
				messageId: produced.messageId,
				topic: produced.topic,
				partitionKey: publishOptions.key ?? "",
				offset: produced.offset,
				publishedAt: produced.publishedAt,
				deduped: produced.deduped,
			});
			emitLocal({
				type: produced.deduped
					? "messaging.published.deduped"
					: "messaging.published",
				topic: physical,
				messageId: produced.messageId,
			});
			if (options.metering) {
				await options.metering.emit(
					createUsageEvent({
						tenantId,
						eventType: "messaging.publish",
						resource: physical,
						quantity: 1,
						unit: "message",
						metadata: {
							backend: "native-kafka",
							cluster: cluster.name,
							fidelity: "live",
						},
					}),
				);
			}
			return result;
		},

		async consume(topic, consumerGroup, consumeOptions = {}) {
			const physical = tenantScopedTopicName(tenantId, topic);
			const group = tenantScopedConsumerGroup(tenantId, consumerGroup);
			if (
				physical.length > MESSAGING_SETTLEMENT_ID_LIMIT ||
				group.length > MESSAGING_SETTLEMENT_ID_LIMIT
			)
				throw new MessagingDeliveryError("messaging scope is not bounded");
			const maxMessages = consumeOptions.maxMessages ?? 1;
			if (
				!Number.isSafeInteger(maxMessages) ||
				maxMessages < 1 ||
				maxMessages > pendingCommits.capacity()
			)
				throw new MessagingDeliveryError(
					"invalid or unavailable messaging capacity",
				);
			const batch = await transport.fetch({
				topic: physical,
				consumerGroup: group,
				maxMessages,
			});
			if (batch.length > maxMessages)
				throw new MessagingDeliveryError("broker returned too many messages");
			const claims: {
				messageId: MessagingMessageId;
				leaseId: MessagingLeaseId;
				scope: string;
				context: { topic: TopicName; group: string; backendLease: string };
			}[] = [];
			const mapped: ConsumedMessage[] = batch.map((m) => {
				const messageId = m.messageId;
				if (
					messageId.length > MESSAGING_SETTLEMENT_ID_LIMIT ||
					m.leaseId.length > MESSAGING_SETTLEMENT_ID_LIMIT
				)
					throw new MessagingDeliveryError(
						"messaging lease identity is not bounded",
					);
				if (leaseSequence >= Number.MAX_SAFE_INTEGER)
					throw new MessagingDeliveryError(
						"messaging lease sequence exhausted",
					);
				const leaseId = parseMessagingLeaseId(
					`kafka-${leasePrefix}-${++leaseSequence}`,
				);
				claims.push({
					messageId,
					leaseId,
					scope: JSON.stringify([physical, group, messageId]),
					context: {
						topic: physical,
						group,
						backendLease: parseMessagingLeaseId(m.leaseId),
					},
				});
				return Object.freeze({
					messageId,
					topic: m.topic,
					consumerGroup: parseConsumerGroupId(m.consumerGroup),
					body: m.body,
					deliveryAttempt: m.deliveryAttempt,
					leaseId,
					receivedAt: m.receivedAt,
					headers: m.headers,
				});
			});
			pendingCommits.register(claims);
			for (const m of mapped) {
				emitLocal({
					type: "messaging.consumed",
					topic: physical,
					messageId: m.messageId,
					consumerGroup: group,
				});
			}
			await meterConsume(
				options.metering,
				cluster,
				topic,
				group,
				mapped.length,
				"live",
			);
			return mapped;
		},

		async subscribe(topic, consumerGroup, handler, consumeOptions = {}) {
			const batch = await live.consume(topic, consumerGroup, {
				maxMessages: consumeOptions.maxMessages ?? 32,
				...consumeOptions,
			});
			let handled = 0;
			const physical = tenantScopedTopicName(tenantId, topic);
			const group = tenantScopedConsumerGroup(tenantId, consumerGroup);
			const sub = [...subscriptions.values()].find(
				(s) => s.topic === physical && s.consumerGroup === group,
			);
			const maxAttempts = sub?.maxDeliveryAttempts ?? 5;

			for (const [index, message] of batch.entries()) {
				const exhausted = (): never => {
					emitLocal({
						type: "messaging.delivery.exhausted",
						topic: physical,
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
			const context = await pendingCommits.settle(id, lease, "ack", (value) =>
				transport.commit({
					topic: value.topic,
					consumerGroup: value.group,
					messageId: id,
					leaseId: value.backendLease,
				}),
			);
			try {
				emitLocal({
					type: "messaging.acked",
					topic: context.topic,
					messageId: id,
				});
			} catch {
				throw new MessagingSettlementCommittedError("ack", id, lease);
			}
		},

		async nack(messageId, leaseId, reason) {
			const id = parseMessagingMessageId(String(messageId));
			const lease = parseMessagingLeaseId(String(leaseId));
			const context = await pendingCommits.settle(id, lease, "nack", (value) =>
				transport.release({
					topic: value.topic,
					consumerGroup: value.group,
					messageId: id,
					leaseId: value.backendLease,
				}),
			);
			try {
				emitLocal({
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

async function publishViaInner<TBody>(
	inner: Messaging,
	cluster: KafkaClusterSpec,
	topic: TopicName,
	body: TBody,
	publishOptions: PublishOptions | undefined,
	metering: MeteringBus | undefined,
	fidelity: "simulated" | "live",
): Promise<PublishResult> {
	const delivery: DeliveryGuarantee =
		publishOptions?.delivery ??
		(cluster.transactional ? "exactly-once" : "at-least-once");
	const result = await inner.publish(topic, body, {
		...publishOptions,
		delivery,
	});
	if (metering) {
		await metering.emit(
			createUsageEvent({
				tenantId: parseTenantId(cluster.tenantId),
				eventType: "messaging.publish",
				resource: tenantScopedTopicName(cluster.tenantId, topic),
				quantity: 1,
				unit: "message",
				metadata: {
					backend: "native-kafka",
					cluster: cluster.name,
					fidelity,
				},
			}),
		);
	}
	return result;
}

async function meterConsume(
	metering: MeteringBus | undefined,
	cluster: KafkaClusterSpec,
	topic: TopicName | string,
	group: string,
	quantity: number,
	fidelity: "simulated" | "live",
): Promise<void> {
	if (!metering || quantity === 0) return;
	await metering.emit(
		createUsageEvent({
			tenantId: parseTenantId(cluster.tenantId),
			eventType: "messaging.consume",
			resource: tenantScopedTopicName(cluster.tenantId, String(topic)),
			quantity,
			unit: "message",
			metadata: {
				backend: "native-kafka",
				consumerGroup: String(group),
				fidelity,
			},
		}),
	);
}
