import {
	type ConsumedMessage,
	createInMemoryMessaging,
	createUsageEvent,
	type Messaging,
	MessagingCapabilityError,
	MessagingDeliveryError,
	type MessagingEvent,
	type MessagingLeaseId,
	type MessagingMessageId,
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
}

export interface DaprMessaging extends Messaging {
	readonly pubsubName: string;
	readonly fidelity: "simulated" | "live";
	readonly placement: "dapr-pubsub";
	readonly client: DaprSidecarClient | null;
	flush?(): Promise<void>;
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
		deadLetter: true,
		partitionAware: false,
		crossYardFederation: true,
	};

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
			async flush() {},
		};
		return Object.freeze(simulated);
	}

	const eventLog: MessagingEvent[] = [];
	const pending = new Map<string, { topic: string; group: string }>();
	const pendingOps: Promise<void>[] = [];
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
			const name = tenantScopedTopicName(spec.tenantId, spec.name);
			emit({ type: "messaging.topic.created", topic: name });
			return Object.freeze({ ...spec, name });
		},

		async ensureSubscription(spec) {
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
			const drained = await client.drain(
				config.defaultPubsubName,
				physical,
				opts.maxMessages ?? 1,
				group,
			);
			const batch: ConsumedMessage[] = drained.map((m) => {
				const messageId = parseMessagingMessageId(m.id);
				const leaseId = parseMessagingLeaseId(`dapr-lease-${m.id}`);
				pending.set(`${messageId}::${leaseId}`, {
					topic: physical,
					group,
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
			let deadLettered = 0;
			for (const message of batch) {
				try {
					await handler(message);
					await doAck(
						client,
						pending,
						message.messageId,
						message.leaseId,
						emit,
					);
					handled += 1;
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					if (message.deliveryAttempt >= maxAttempts) {
						await doAck(
							client,
							pending,
							message.messageId,
							message.leaseId,
							emit,
						);
						deadLettered += 1;
						emit({
							type: "messaging.dead_lettered",
							topic: message.topic,
							messageId: message.messageId,
							consumerGroup: group,
							reason: "max_delivery_attempts",
						});
						emit({
							type: "messaging.delivery.permanent_failure",
							topic: message.topic,
							messageId: message.messageId,
							consumerGroup: group,
							reason: reason || "max_delivery_attempts",
						});
					} else {
						await doNack(
							client,
							pending,
							message.messageId,
							message.leaseId,
							reason,
							emit,
						);
					}
				}
			}
			return { handled, deadLettered };
		},

		ack(messageId, leaseId) {
			const id = parseMessagingMessageId(String(messageId));
			const lease = parseMessagingLeaseId(String(leaseId));
			if (!pending.has(`${id}::${lease}`)) {
				throw new MessagingDeliveryError(`no inflight dapr message ${id}`);
			}
			pendingOps.push(doAck(client, pending, id, lease, emit));
		},

		nack(messageId, leaseId, reason) {
			const id = parseMessagingMessageId(String(messageId));
			const lease = parseMessagingLeaseId(String(leaseId));
			if (!pending.has(`${id}::${lease}`)) {
				throw new MessagingDeliveryError(`no inflight dapr message ${id}`);
			}
			pendingOps.push(doNack(client, pending, id, lease, reason, emit));
		},

		events() {
			return eventLog.slice();
		},

		async flush() {
			await Promise.all(pendingOps.splice(0, pendingOps.length));
		},
	};

	return Object.freeze(live);
}

async function doAck(
	client: DaprSidecarClient,
	pending: Map<string, { topic: string; group: string }>,
	messageId: MessagingMessageId,
	leaseId: MessagingLeaseId,
	emit: (e: Omit<MessagingEvent, "at" | "tenantId">) => void,
): Promise<void> {
	const key = `${messageId}::${leaseId}`;
	const meta = pending.get(key);
	if (!meta)
		throw new MessagingDeliveryError(`no inflight dapr message ${messageId}`);
	await client.ack(String(messageId), meta.group);
	pending.delete(key);
	emit({
		type: "messaging.acked",
		topic: parseTopicName(meta.topic),
		messageId,
	});
}

async function doNack(
	client: DaprSidecarClient,
	pending: Map<string, { topic: string; group: string }>,
	messageId: MessagingMessageId,
	leaseId: MessagingLeaseId,
	reason: string | undefined,
	emit: (e: Omit<MessagingEvent, "at" | "tenantId">) => void,
): Promise<void> {
	const key = `${messageId}::${leaseId}`;
	const meta = pending.get(key);
	if (!meta)
		throw new MessagingDeliveryError(`no inflight dapr message ${messageId}`);
	await client.nack(String(messageId), meta.group);
	pending.delete(key);
	emit({
		type: "messaging.nacked",
		topic: parseTopicName(meta.topic),
		messageId,
		reason: reason ?? "nack",
	});
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
