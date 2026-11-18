import {
	type ConsumedMessage,
	type ConsumerGroupId,
	createInMemoryMessaging,
	createUsageEvent,
	type DeliveryGuarantee,
	MESSAGING_EVENTS,
	type Messaging,
	type MessagingCapabilities,
	MessagingCapabilityError,
	MessagingDeliveryError,
	type MessagingEvent,
	type MessagingLeaseId,
	type MessagingMessageId,
	type MeteringBus,
	type PublishOptions,
	type PublishResult,
	parseConsumerGroupId,
	parseMessagingLeaseId,
	parseMessagingMessageId,
	parseTenantId,
	parseTopicName,
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
}

export interface KafkaMessaging extends Messaging {
	readonly cluster: KafkaClusterSpec;
	readonly fidelity: "simulated" | "live";
	readonly transport: KafkaBrokerTransport | null;
	readonly partitionsFor: (topic: TopicName) => number;
	flush?(): Promise<void>;
}

export function createKafkaMessaging(
	options: KafkaMessagingOptions,
): KafkaMessaging {
	const { cluster } = options;
	const transport = options.transport ?? null;
	const fidelity = transport?.fidelity === "live" ? "live" : "simulated";
	if (options.live === true && fidelity !== "live") {
		throw new MessagingCapabilityError(
			"createKafkaMessaging: live fidelity requires a KafkaBrokerTransport that declares live fidelity",
		);
	}
	const capabilities: MessagingCapabilities = {
		...KAFKA_MESSAGING_CAPABILITIES,
		transactionalProduce: cluster.transactional,
		idempotentProduce: cluster.idempotentProducer,
		schemaRegistry: Boolean(cluster.schemaRegistryRef),
	};

	const partitionMap = new Map<string, number>();

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
			async flush() {},
		};
		return Object.freeze(simulated);
	}

	const eventLog: MessagingEvent[] = [];
	const pendingCommits = new Map<string, { topic: string; group: string }>();
	const pendingOps: Promise<void>[] = [];
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

	const clientBacked: KafkaMessaging = {
		backend: "native-kafka",
		capabilities,
		cluster,
		fidelity,
		transport,
		partitionsFor(topic) {
			return partitionMap.get(topic) ?? 3;
		},

		async ensureTopic(spec) {
			const scoped: TopicSpec = Object.freeze({
				...spec,
				name: tenantScopedTopicName(spec.tenantId, spec.name),
			});
			await transport.ensureTopic(scoped.name, { partitions: 3 });
			partitionMap.set(scoped.name, 3);
			emitLocal({ type: MESSAGING_EVENTS.TopicCreated, topic: scoped.name });
			return scoped;
		},

		async ensureSubscription(spec) {
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
				type: MESSAGING_EVENTS.SubscriptionCreated,
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
					? MESSAGING_EVENTS.PublishDeduplicated
					: MESSAGING_EVENTS.MessagePublished,
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
							fidelity,
						},
					}),
				);
			}
			return result;
		},

		async consume(topic, consumerGroup, consumeOptions = {}) {
			const physical = tenantScopedTopicName(tenantId, topic);
			const group = tenantScopedConsumerGroup(tenantId, consumerGroup);
			const batch = await transport.fetch({
				topic: physical,
				consumerGroup: group,
				maxMessages: consumeOptions.maxMessages ?? 1,
			});
			const mapped: ConsumedMessage[] = batch.map((m) => {
				const messageId = m.messageId;
				const leaseId = parseMessagingLeaseId(m.leaseId);
				pendingCommits.set(`${messageId}::${leaseId}`, {
					topic: physical,
					group,
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
			for (const m of mapped) {
				emitLocal({
					type: MESSAGING_EVENTS.MessageConsumed,
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
				fidelity,
			);
			return mapped;
		},

		async subscribe(topic, consumerGroup, handler, consumeOptions = {}) {
			const batch = await clientBacked.consume(topic, consumerGroup, {
				maxMessages: consumeOptions.maxMessages ?? 32,
				...consumeOptions,
			});
			let handled = 0;
			let deadLettered = 0;
			const physical = tenantScopedTopicName(tenantId, topic);
			const group = tenantScopedConsumerGroup(tenantId, consumerGroup);
			const sub = [...subscriptions.values()].find(
				(s) => s.topic === physical && s.consumerGroup === group,
			);
			const maxAttempts = sub?.maxDeliveryAttempts ?? 5;

			for (const message of batch) {
				try {
					await handler(message);
					await ackAsync(
						transport,
						pendingCommits,
						message.messageId,
						message.leaseId,
						emitLocal,
					);
					handled += 1;
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					if (message.deliveryAttempt >= maxAttempts) {
						await ackAsync(
							transport,
							pendingCommits,
							message.messageId,
							message.leaseId,
							emitLocal,
						);
						deadLettered += 1;
						emitLocal({
							type: MESSAGING_EVENTS.MessageDeadLettered,
							topic: physical,
							messageId: message.messageId,
							consumerGroup: group,
							reason: "max_delivery_attempts",
						});
						emitLocal({
							type: MESSAGING_EVENTS.DeliveryPermanentlyFailed,
							topic: physical,
							messageId: message.messageId,
							consumerGroup: group,
							reason: reason || "max_delivery_attempts",
						});
					} else {
						await nackAsync(
							transport,
							pendingCommits,
							message.messageId,
							message.leaseId,
							reason,
							emitLocal,
						);
					}
				}
			}
			return { handled, deadLettered };
		},

		ack(messageId, leaseId) {
			const id = parseMessagingMessageId(String(messageId));
			const lease = parseMessagingLeaseId(String(leaseId));
			const pending = pendingCommits.get(`${id}::${lease}`);
			if (!pending) {
				throw new MessagingDeliveryError(`no inflight kafka message ${id}`);
			}
			pendingOps.push(
				ackAsync(transport, pendingCommits, id, lease, emitLocal),
			);
		},

		nack(messageId, leaseId, reason) {
			const id = parseMessagingMessageId(String(messageId));
			const lease = parseMessagingLeaseId(String(leaseId));
			const pending = pendingCommits.get(`${id}::${lease}`);
			if (!pending) {
				throw new MessagingDeliveryError(`no inflight kafka message ${id}`);
			}
			pendingOps.push(
				nackAsync(transport, pendingCommits, id, lease, reason, emitLocal),
			);
		},

		events() {
			return eventLog.slice();
		},

		async flush() {
			await Promise.all(pendingOps.splice(0, pendingOps.length));
		},
	};

	return Object.freeze(clientBacked);
}

async function ackAsync(
	transport: KafkaBrokerTransport,
	pendingCommits: Map<string, { topic: string; group: string }>,
	messageId: MessagingMessageId,
	leaseId: MessagingLeaseId,
	emitLocal: (e: Omit<MessagingEvent, "at" | "tenantId">) => void,
): Promise<void> {
	const key = `${messageId}::${leaseId}`;
	const pending = pendingCommits.get(key);
	if (!pending) {
		throw new MessagingDeliveryError(`no inflight kafka message ${messageId}`);
	}
	await transport.commit({
		topic: parseTopicName(pending.topic),
		consumerGroup: pending.group,
		messageId,
		leaseId,
	});
	pendingCommits.delete(key);
	emitLocal({
		type: MESSAGING_EVENTS.MessageAcknowledged,
		topic: parseTopicName(pending.topic),
		messageId,
	});
}

async function nackAsync(
	transport: KafkaBrokerTransport,
	pendingCommits: Map<string, { topic: string; group: string }>,
	messageId: MessagingMessageId,
	leaseId: MessagingLeaseId,
	reason: string | undefined,
	emitLocal: (e: Omit<MessagingEvent, "at" | "tenantId">) => void,
): Promise<void> {
	const key = `${messageId}::${leaseId}`;
	const pending = pendingCommits.get(key);
	if (!pending) {
		throw new MessagingDeliveryError(`no inflight kafka message ${messageId}`);
	}
	await transport.release({
		topic: parseTopicName(pending.topic),
		consumerGroup: pending.group,
		messageId,
		leaseId,
	});
	pendingCommits.delete(key);
	emitLocal({
		type: MESSAGING_EVENTS.MessageNacked,
		topic: parseTopicName(pending.topic),
		messageId,
		reason: reason ?? "nack",
	});
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
