import { randomUUID } from "node:crypto";
import { CoreParseError } from "../errors.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import {
	deepFreeze,
	isoTimestamp,
	nonEmptyString,
	nonNegativeInteger,
	positiveInteger,
} from "../parse-utils.js";
import { mustGet } from "../total-access.js";
import type { TenantId } from "./tenant.js";

function stringBagFrom(value: JsonObject) {
	const bag: { [key: string]: string } = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isJsonString(entry)) bag[key] = entry;
	}
	return bag;
}

export const MESSAGING_PORT_CONTRACT_VERSION = "hobo.messaging-port/v2";

export type DeliveryGuarantee =
	| "at-least-once"
	| "exactly-once"
	| "at-most-once";

export type ActorPlacementMode = "native" | "dapr" | "rivet" | "celld";

export type TopicName = string & { readonly __brand: "TopicName" };
export type ConsumerGroupId = string & { readonly __brand: "ConsumerGroupId" };
export type MessagingMessageId = string & {
	readonly __brand: "MessagingMessageId";
};
export type MessagingLeaseId = string & {
	readonly __brand: "MessagingLeaseId";
};
export type SubscriptionName = string & {
	readonly __brand: "SubscriptionName";
};

// domain-view:
export interface TopicSpec {
	readonly name: TopicName;
	readonly tenantId: TenantId;
	readonly projectId?: string;
	readonly delivery: DeliveryGuarantee;
	readonly deadLetterTopic?: TopicName;
	readonly schemaRef?: string;
	readonly labels?: Readonly<Record<string, string>>;
}

// domain-view:
export interface SubscriptionSpec {
	readonly name: SubscriptionName;
	readonly topic: TopicName;
	readonly consumerGroup: ConsumerGroupId;
	readonly tenantId: TenantId;
	readonly delivery: DeliveryGuarantee;
	readonly maxDeliveryAttempts: number;
	readonly deadLetterTopic?: TopicName;
}

// domain-view:
export interface MessagingSpec {
	readonly id: string;
	readonly tenantId: TenantId;
	readonly topics: readonly TopicSpec[];
	readonly subscriptions: readonly SubscriptionSpec[];
	readonly backend: string;
}

export interface PublishOptions {
	readonly key?: string;
	readonly idempotencyKey?: string;
	readonly contentType?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly delivery?: DeliveryGuarantee;
}

export interface PublishResult {
	readonly messageId: MessagingMessageId;
	readonly topic: TopicName;
	readonly partitionKey: string;
	readonly offset: number;
	readonly publishedAt: string;
	readonly deduped: boolean;
}

export interface ConsumeOptions {
	readonly maxMessages?: number;
	readonly visibilityTimeoutMs?: number;
}

// domain-view:
export interface ConsumedMessage<TBody = unknown> {
	readonly messageId: MessagingMessageId;
	readonly topic: TopicName;
	readonly consumerGroup: ConsumerGroupId;
	readonly body: TBody;
	readonly deliveryAttempt: number;
	readonly leaseId: MessagingLeaseId;
	readonly receivedAt: string;
	readonly headers: Readonly<Record<string, string>>;
}

export interface MessagingEvent {
	readonly type:
		| "messaging.topic.created"
		| "messaging.subscription.created"
		| "messaging.published"
		| "messaging.published.deduped"
		| "messaging.consumed"
		| "messaging.acked"
		| "messaging.nacked"
		| "messaging.dead_lettered"
		| "messaging.delivery.permanent_failure"
		| "messaging.delivery.exhausted"
		| "messaging.federated";
	readonly topic: TopicName;
	readonly messageId?: MessagingMessageId;
	readonly consumerGroup?: ConsumerGroupId;
	readonly tenantId: TenantId;
	readonly reason?: string;
	readonly at: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface Messaging {
	readonly backend: string;
	readonly capabilities: MessagingCapabilities;

	ensureTopic(spec: TopicSpec): Promise<TopicSpec>;
	ensureSubscription(spec: SubscriptionSpec): Promise<SubscriptionSpec>;

	publish<TBody = unknown>(
		topic: TopicName,
		body: TBody,
		options?: PublishOptions,
	): Promise<PublishResult>;

	consume(
		topic: TopicName,
		consumerGroup: ConsumerGroupId,
		options?: ConsumeOptions,
	): Promise<readonly ConsumedMessage[]>;

	subscribe(
		topic: TopicName,
		consumerGroup: ConsumerGroupId,
		handler: (message: ConsumedMessage) => Promise<void>,
		options?: ConsumeOptions,
	): Promise<{ handled: number; deadLettered: number }>;

	ack(messageId: MessagingMessageId, leaseId: MessagingLeaseId): Promise<void>;
	nack(
		messageId: MessagingMessageId,
		leaseId: MessagingLeaseId,
		reason?: string,
	): Promise<void>;

	events(): readonly MessagingEvent[];
}

export interface MessagingCapabilities {
	readonly deliveryGuarantees: readonly DeliveryGuarantee[];
	readonly consumerGroups: boolean;
	readonly transactionalProduce: boolean;
	readonly idempotentProduce: boolean;
	readonly schemaRegistry: boolean;
	readonly deadLetter: boolean;
	readonly partitionAware: boolean;
	readonly crossYardFederation: boolean;
}

export const PORTABLE_MESSAGING_CAPABILITIES: MessagingCapabilities =
	deepFreeze({
		deliveryGuarantees: ["at-least-once"] as const,
		consumerGroups: true,
		transactionalProduce: false,
		idempotentProduce: false,
		schemaRegistry: false,
		deadLetter: false,
		partitionAware: false,
		crossYardFederation: false,
	});

export class MessagingParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_MESSAGING_PARSE", path, expected, received, message);
		this.name = "MessagingParseError";
	}
}

export class MessagingDeliveryError extends Error {
	readonly code = "MESSAGING_DELIVERY" as const;
	constructor(message: string) {
		super(message);
		this.name = "MessagingDeliveryError";
	}
}

export class MessagingDeliveryExhaustedError extends Error {
	readonly code = "MESSAGING_DELIVERY_EXHAUSTED" as const;
	constructor(
		readonly delivery: ConsumedMessage,
		readonly unprocessed: readonly ConsumedMessage[],
		readonly handled: number,
	) {
		super("Delivery attempts exhausted; the message remains unsettled");
		this.name = "MessagingDeliveryExhaustedError";
	}
}

export class MessagingSettlementCommittedError extends Error {
	readonly code = "MESSAGING_SETTLEMENT_COMMITTED" as const;
	constructor(
		readonly operation: "ack" | "nack",
		readonly messageId: MessagingMessageId,
		readonly leaseId: MessagingLeaseId,
	) {
		super(
			`${operation} for ${messageId} committed but local observation failed`,
		);
		this.name = "MessagingSettlementCommittedError";
	}
}

export class MessagingCapabilityError extends Error {
	readonly code = "MESSAGING_CAPABILITY" as const;
	constructor(message: string) {
		super(message);
		this.name = "MessagingCapabilityError";
	}
}

export function assertDeadLetterSupported(
	capabilities: MessagingCapabilities,
	spec: { readonly deadLetterTopic?: TopicName },
): void {
	if (spec.deadLetterTopic !== undefined && !capabilities.deadLetter)
		throw new MessagingCapabilityError(
			"backend cannot transfer messages to a dead-letter topic",
		);
}

const DELIVERY_SET = new Set<DeliveryGuarantee>([
	"at-least-once",
	"exactly-once",
	"at-most-once",
]);

export function parseTopicName(value: string): TopicName {
	return nonEmptyString(value, "topic", MessagingParseError) as TopicName;
}

export function parseConsumerGroupId(value: string): ConsumerGroupId {
	return nonEmptyString(
		value,
		"consumerGroup",
		MessagingParseError,
	) as ConsumerGroupId;
}

export function parseMessagingMessageId(value: string): MessagingMessageId {
	return nonEmptyString(
		value,
		"messageId",
		MessagingParseError,
	) as MessagingMessageId;
}

export function parseMessagingLeaseId(value: string): MessagingLeaseId {
	return nonEmptyString(
		value,
		"leaseId",
		MessagingParseError,
	) as MessagingLeaseId;
}

export function parseSubscriptionName(value: string): SubscriptionName {
	return nonEmptyString(
		value,
		"subscription",
		MessagingParseError,
	) as SubscriptionName;
}

export function parseDeliveryGuarantee(
	value: JsonValue | undefined,
): DeliveryGuarantee {
	if (!isJsonString(value) || !DELIVERY_SET.has(value as DeliveryGuarantee)) {
		throw new MessagingParseError(
			"delivery",
			"at-least-once|exactly-once|at-most-once",
			value,
		);
	}
	return value as DeliveryGuarantee;
}

export function parseActorPlacementMode(
	value: JsonValue | undefined,
): ActorPlacementMode {
	if (
		value === "native" ||
		value === "dapr" ||
		value === "rivet" ||
		value === "celld"
	) {
		return value;
	}
	throw new MessagingParseError(
		"actorPlacementMode",
		"native|dapr|rivet|celld",
		value,
	);
}

export function tenantScopedTopicName(
	tenantId: string,
	topic: string,
): TopicName {
	const tenant = nonEmptyString(tenantId, "tenantId", MessagingParseError);
	const name = nonEmptyString(topic, "topic", MessagingParseError);
	if (name.startsWith(`${tenant}.`) || name.startsWith(`${tenant}/`)) {
		return name as TopicName;
	}
	return `${tenant}.${name}` as TopicName;
}

export function tenantScopedConsumerGroup(
	tenantId: string,
	group: string,
): ConsumerGroupId {
	const tenant = nonEmptyString(tenantId, "tenantId", MessagingParseError);
	const name = nonEmptyString(group, "consumerGroup", MessagingParseError);
	if (name.startsWith(`${tenant}.`) || name.startsWith(`${tenant}/`)) {
		return name as ConsumerGroupId;
	}
	return `${tenant}.${name}` as ConsumerGroupId;
}

export function parseTopicSpec(input: JsonValue | undefined): TopicSpec {
	if (!input || !isJsonObject(input)) {
		throw new MessagingParseError("topicSpec", "object", input);
	}
	const src = input as JsonObject;
	const delivery = parseDeliveryGuarantee(src.delivery ?? "at-least-once");
	const spec: TopicSpec = {
		name: parseTopicName(String(src.name ?? "")),
		tenantId: nonEmptyString(
			String(src.tenantId ?? src.tenant_id ?? ""),
			"tenantId",
			MessagingParseError,
		) as TenantId,
		delivery,
		...(src.projectId !== undefined || src.project_id !== undefined
			? { projectId: String(src.projectId ?? src.project_id) }
			: undefined),
		...(src.deadLetterTopic || src.dead_letter_topic
			? {
					deadLetterTopic: parseTopicName(
						String(src.deadLetterTopic ?? src.dead_letter_topic),
					),
				}
			: undefined),
		...(src.schemaRef || src.schema_ref
			? { schemaRef: String(src.schemaRef ?? src.schema_ref) }
			: undefined),
		...(isJsonObject(src.labels)
			? { labels: stringBagFrom(src.labels) }
			: undefined),
	};
	return deepFreeze(spec);
}

export function parseSubscriptionSpec(
	input: JsonValue | undefined,
): SubscriptionSpec {
	if (!input || !isJsonObject(input)) {
		throw new MessagingParseError("subscriptionSpec", "object", input);
	}
	const src = input as JsonObject;
	const delivery = parseDeliveryGuarantee(src.delivery ?? "at-least-once");
	const max = positiveInteger(
		src.maxDeliveryAttempts ?? src.max_delivery_attempts ?? 5,
		"maxDeliveryAttempts",
		MessagingParseError,
	);
	const spec: SubscriptionSpec = {
		name: parseSubscriptionName(String(src.name ?? "")),
		topic: parseTopicName(String(src.topic ?? "")),
		consumerGroup: parseConsumerGroupId(
			String(src.consumerGroup ?? src.consumer_group ?? ""),
		),
		tenantId: nonEmptyString(
			String(src.tenantId ?? src.tenant_id ?? ""),
			"tenantId",
			MessagingParseError,
		) as TenantId,
		delivery,
		maxDeliveryAttempts: max,
		...(src.deadLetterTopic || src.dead_letter_topic
			? {
					deadLetterTopic: parseTopicName(
						String(src.deadLetterTopic ?? src.dead_letter_topic),
					),
				}
			: undefined),
	};
	return deepFreeze(spec);
}

export function parseMessagingSpec(
	input: JsonValue | undefined,
): MessagingSpec {
	if (!input || !isJsonObject(input)) {
		throw new MessagingParseError("messagingSpec", "object", input);
	}
	const src = input as JsonObject;
	const topics = Array.isArray(src.topics)
		? src.topics.map((t) => parseTopicSpec(t))
		: [];
	const subscriptions = Array.isArray(src.subscriptions)
		? src.subscriptions.map((s) => parseSubscriptionSpec(s))
		: [];
	return deepFreeze({
		id: nonEmptyString(String(src.id ?? ""), "id", MessagingParseError),
		tenantId: nonEmptyString(
			String(src.tenantId ?? src.tenant_id ?? ""),
			"tenantId",
			MessagingParseError,
		) as TenantId,
		topics,
		subscriptions,
		backend: nonEmptyString(
			String(src.backend ?? "local-memory"),
			"backend",
			MessagingParseError,
		),
	});
}

export function assertDeliverySupported(
	capabilities: MessagingCapabilities,
	requested: DeliveryGuarantee,
): void {
	if (!capabilities.deliveryGuarantees.includes(requested)) {
		throw new MessagingCapabilityError(
			`backend does not support delivery guarantee '${requested}' (supports: ${capabilities.deliveryGuarantees.join(", ")})`,
		);
	}
}

export interface InMemoryMessagingOptions {
	readonly tenantId?: string;
	readonly capabilities?: Partial<MessagingCapabilities>;
	readonly now?: () => string;
}

interface StoredMessage {
	messageId: MessagingMessageId;
	topic: TopicName;
	body: JsonValue;
	headers: Record<string, string>;
	partitionKey: string;
	offset: number;
	publishedAt: string;
	idempotencyKey?: string;
}

interface GroupCursor {
	acked: Set<string>;
	inflight: Map<
		string,
		{ leaseId: MessagingLeaseId; expiresAtMs: number; attempt: number }
	>;
	attempts: Map<string, number>;
}

export function createInMemoryMessaging(
	options: InMemoryMessagingOptions = {},
): Messaging {
	if (options.capabilities?.deadLetter === true)
		throw new MessagingCapabilityError(
			"in-memory messaging cannot transfer messages to a dead-letter topic",
		);
	const tenantId = (options.tenantId ?? "local") as TenantId;
	const now = options.now ?? (() => new Date().toISOString());
	const capabilities: MessagingCapabilities = deepFreeze({
		...PORTABLE_MESSAGING_CAPABILITIES,
		...options.capabilities,
		deliveryGuarantees:
			options.capabilities?.deliveryGuarantees ??
			PORTABLE_MESSAGING_CAPABILITIES.deliveryGuarantees,
	});

	const topics = new Map<string, TopicSpec>();
	const subscriptions = new Map<string, SubscriptionSpec>();
	const logs = new Map<string, StoredMessage[]>();
	const idempotency = new Map<string, PublishResult>();
	const groups = new Map<string, GroupCursor>();
	const eventLog: MessagingEvent[] = [];
	let offsetSeq = 0;
	let msgSeq = 0;
	let leaseSeq = 0;
	const leasePrefix = randomUUID();

	const emit = (
		partial: Omit<MessagingEvent, "at" | "tenantId"> & {
			tenantId?: TenantId;
		},
	) => {
		eventLog.push(
			deepFreeze({
				...partial,
				tenantId: partial.tenantId ?? tenantId,
				at: now(),
			}),
		);
	};

	const groupKey = (topic: TopicName, group: ConsumerGroupId) =>
		`${topic}::${group}`;

	const getGroup = (topic: TopicName, group: ConsumerGroupId): GroupCursor => {
		const key = groupKey(topic, group);
		let g = groups.get(key);
		if (!g) {
			g = { acked: new Set(), inflight: new Map(), attempts: new Map() };
			groups.set(key, g);
		}
		return g;
	};

	const messaging: Messaging = {
		backend: "local-memory",
		capabilities,

		async ensureTopic(spec) {
			assertDeadLetterSupported(capabilities, spec);
			const scoped: TopicSpec = deepFreeze({
				...spec,
				name: tenantScopedTopicName(spec.tenantId, spec.name),
			});
			if (!topics.has(scoped.name)) {
				topics.set(scoped.name, scoped);
				logs.set(scoped.name, []);
				emit({ type: "messaging.topic.created", topic: scoped.name });
			}
			return mustGet(topics, scoped.name);
		},

		async ensureSubscription(spec) {
			assertDeadLetterSupported(capabilities, spec);
			const topic = tenantScopedTopicName(spec.tenantId, spec.topic);
			const group = tenantScopedConsumerGroup(
				spec.tenantId,
				spec.consumerGroup,
			);
			const scoped: SubscriptionSpec = deepFreeze({
				...spec,
				topic,
				consumerGroup: group,
			});
			if (!topics.has(topic)) {
				await messaging.ensureTopic({
					name: parseTopicName(String(spec.topic)),
					tenantId: spec.tenantId,
					delivery: spec.delivery,
				});
			}
			const key = `${scoped.name}::${topic}::${group}`;
			if (!subscriptions.has(key)) {
				subscriptions.set(key, scoped);
				emit({
					type: "messaging.subscription.created",
					topic,
					consumerGroup: group,
				});
			}
			return scoped;
		},

		async publish(topic, body, publishOptions = {}) {
			const delivery = publishOptions.delivery ?? "at-least-once";
			assertDeliverySupported(capabilities, delivery);

			const physical = tenantScopedTopicName(tenantId, topic);
			if (!logs.has(physical)) {
				await messaging.ensureTopic({
					name: parseTopicName(String(topic)),
					tenantId,
					delivery,
				});
			}

			if (publishOptions.idempotencyKey) {
				const prior = idempotency.get(
					`${physical}::${publishOptions.idempotencyKey}`,
				);
				if (prior) {
					emit({
						type: "messaging.published.deduped",
						topic: physical,
						messageId: prior.messageId,
					});
					return deepFreeze({ ...prior, deduped: true });
				}
			}

			const messageId = parseMessagingMessageId(`msg-${++msgSeq}`);
			const offset = ++offsetSeq;
			const publishedAt = now();
			const partitionKey = publishOptions.key ?? "";
			const stored: StoredMessage = {
				messageId,
				topic: physical,
				body: cloneAsJson(body),
				headers: { ...publishOptions.headers },
				partitionKey,
				offset,
				publishedAt,
				...(publishOptions.idempotencyKey
					? { idempotencyKey: publishOptions.idempotencyKey }
					: undefined),
			};
			mustGet(logs, physical).push(stored);
			const result: PublishResult = deepFreeze({
				messageId,
				topic: physical,
				partitionKey,
				offset,
				publishedAt,
				deduped: false,
			});
			if (publishOptions.idempotencyKey) {
				idempotency.set(
					`${physical}::${publishOptions.idempotencyKey}`,
					result,
				);
			}
			emit({ type: "messaging.published", topic: physical, messageId });
			return result;
		},

		async consume(topic, consumerGroup, consumeOptions = {}) {
			const physical = tenantScopedTopicName(tenantId, topic);
			const group = tenantScopedConsumerGroup(tenantId, consumerGroup);
			const max = positiveInteger(
				consumeOptions.maxMessages ?? 1,
				"maxMessages",
				MessagingParseError,
			);
			const visibility = positiveInteger(
				consumeOptions.visibilityTimeoutMs ?? 30_000,
				"visibilityTimeoutMs",
				MessagingParseError,
			);
			const log = logs.get(physical) ?? [];
			const cursor = getGroup(physical, group);
			const nowMs = Date.parse(now());
			const out: ConsumedMessage[] = [];

			for (const msg of log) {
				if (out.length >= max) break;
				if (cursor.acked.has(msg.messageId)) continue;
				const inflight = cursor.inflight.get(msg.messageId);
				if (inflight && inflight.expiresAtMs > nowMs) continue;

				const attempt = (cursor.attempts.get(msg.messageId) ?? 0) + 1;
				cursor.attempts.set(msg.messageId, attempt);
				if (leaseSeq >= Number.MAX_SAFE_INTEGER)
					throw new MessagingDeliveryError(
						"messaging lease sequence exhausted",
					);
				const leaseId = parseMessagingLeaseId(
					`lease-${leasePrefix}-${++leaseSeq}`,
				);
				cursor.inflight.set(msg.messageId, {
					leaseId,
					expiresAtMs: nowMs + visibility,
					attempt,
				});
				const consumed: ConsumedMessage = deepFreeze({
					messageId: msg.messageId,
					topic: physical,
					consumerGroup: group,
					body: msg.body,
					deliveryAttempt: attempt,
					leaseId,
					receivedAt: now(),
					headers: msg.headers,
				});
				out.push(consumed);
				emit({
					type: "messaging.consumed",
					topic: physical,
					messageId: msg.messageId,
					consumerGroup: group,
				});
			}
			return out;
		},

		async subscribe(topic, consumerGroup, handler, consumeOptions = {}) {
			const batch = await messaging.consume(topic, consumerGroup, {
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
					emit({
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
					await messaging.nack(
						message.messageId,
						message.leaseId,
						err instanceof Error ? err.message : String(err),
					);
					continue;
				}
				await messaging.ack(message.messageId, message.leaseId);
				handled += 1;
			}
			return { handled, deadLettered: 0 };
		},

		async ack(messageId, leaseId) {
			let found = false;
			for (const [key, cursor] of groups) {
				const inflight = cursor.inflight.get(messageId);
				if (!inflight) continue;
				found = true;
				if (inflight.leaseId !== leaseId) {
					continue;
				}
				const current = Date.parse(now());
				if (!Number.isFinite(current) || inflight.expiresAtMs <= current)
					throw new MessagingDeliveryError(`lease expired for ${messageId}`);
				cursor.acked.add(messageId);
				cursor.inflight.delete(messageId);
				const topic = parseTopicName(key.split("::")[0] ?? "unknown");
				try {
					emit({ type: "messaging.acked", topic, messageId });
				} catch {
					throw new MessagingSettlementCommittedError(
						"ack",
						messageId,
						leaseId,
					);
				}
				return;
			}
			throw new MessagingDeliveryError(
				found
					? `lease mismatch for ${messageId}`
					: `no inflight message ${messageId}`,
			);
		},

		async nack(messageId, leaseId, reason) {
			let found = false;
			for (const [key, cursor] of groups) {
				const inflight = cursor.inflight.get(messageId);
				if (!inflight) continue;
				found = true;
				if (inflight.leaseId !== leaseId) {
					continue;
				}
				const current = Date.parse(now());
				if (!Number.isFinite(current) || inflight.expiresAtMs <= current)
					throw new MessagingDeliveryError(`lease expired for ${messageId}`);
				cursor.inflight.delete(messageId);
				const topic = parseTopicName(key.split("::")[0] ?? "unknown");
				try {
					emit({
						type: "messaging.nacked",
						topic,
						messageId,
						reason: reason ?? "nack",
					});
				} catch {
					throw new MessagingSettlementCommittedError(
						"nack",
						messageId,
						leaseId,
					);
				}
				return;
			}
			throw new MessagingDeliveryError(
				found
					? `lease mismatch for ${messageId}`
					: `no inflight message ${messageId}`,
			);
		},

		events() {
			return eventLog.slice();
		},
	};

	return Object.freeze(messaging);
}

export function createPublishResult(record: {
	message_id: string;
	topic: string;
	partition_key: string;
	offset: number;
	published_at: string;
	deduped: boolean;
}): PublishResult {
	return deepFreeze({
		messageId: parseMessagingMessageId(record.message_id),
		topic: parseTopicName(record.topic),
		partitionKey: record.partition_key,
		offset: nonNegativeInteger(record.offset, "offset", MessagingParseError),
		publishedAt: isoTimestamp(
			record.published_at,
			"publishedAt",
			MessagingParseError,
		),
		deduped: record.deduped,
	});
}
