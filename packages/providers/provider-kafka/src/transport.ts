/**
 * Kafka broker transport seam (ADR-0138).
 *
 * Production messaging always routes produce/fetch/commit through this
 * interface when fidelity is `live`. Unit tests inject
 * {@link createInMemoryKafkaTransport}; optional env-gated integration can
 * inject a real broker client that implements the same methods.
 */

import {
	type MessagingMessageId,
	MessagingParseError,
	parseMessagingMessageId,
	parseTopicName,
	type TopicName,
} from "@hobo/core";
import { mustGet } from "@hobo/core/total-access";

export interface KafkaProduceRequest {
	readonly topic: TopicName;
	readonly key: string;
	readonly body: unknown;
	readonly headers: Readonly<Record<string, string>>;
	readonly idempotencyKey?: string;
}

export interface KafkaProduceResult {
	readonly messageId: MessagingMessageId;
	readonly topic: TopicName;
	readonly partition: number;
	readonly offset: number;
	readonly publishedAt: string;
	readonly deduped: boolean;
}

export interface KafkaFetchRequest {
	readonly topic: TopicName;
	readonly consumerGroup: string;
	readonly maxMessages: number;
}

export interface KafkaFetchedMessage {
	readonly messageId: MessagingMessageId;
	readonly topic: TopicName;
	readonly consumerGroup: string;
	readonly body: unknown;
	readonly headers: Readonly<Record<string, string>>;
	readonly offset: number;
	readonly partition: number;
	readonly deliveryAttempt: number;
	readonly leaseId: string;
	readonly receivedAt: string;
}

export interface KafkaBrokerTransport {
	readonly kind: "kafka-broker-transport";
	ensureTopic(
		topic: TopicName,
		options?: { partitions?: number },
	): Promise<void>;
	produce(request: KafkaProduceRequest): Promise<KafkaProduceResult>;
	fetch(request: KafkaFetchRequest): Promise<readonly KafkaFetchedMessage[]>;
	commit(request: {
		topic: TopicName;
		consumerGroup: string;
		messageId: MessagingMessageId;
		leaseId: string;
	}): Promise<void>;
	release(request: {
		topic: TopicName;
		consumerGroup: string;
		messageId: MessagingMessageId;
		leaseId: string;
	}): Promise<void>;
}

export interface InMemoryKafkaTransportOptions {
	readonly now?: () => string;
	readonly defaultPartitions?: number;
}

interface LogEntry {
	messageId: MessagingMessageId;
	topic: TopicName;
	key: string;
	body: unknown;
	headers: Record<string, string>;
	partition: number;
	offset: number;
	publishedAt: string;
	idempotencyKey?: string;
}

interface GroupState {
	acked: Set<string>;
	inflight: Map<
		string,
		{ leaseId: string; expiresAtMs: number; attempt: number }
	>;
	attempts: Map<string, number>;
}

/**
 * In-process Kafka-protocol harness used as the live client path under test.
 * Same produce/fetch/commit methods a Redpanda/MSK client adapter implements.
 */
export function createInMemoryKafkaTransport(
	options: InMemoryKafkaTransportOptions = {},
): KafkaBrokerTransport {
	const now = options.now ?? (() => new Date().toISOString());
	const defaultPartitions = options.defaultPartitions ?? 3;
	const logs = new Map<string, LogEntry[]>();
	const partitions = new Map<string, number>();
	const groups = new Map<string, GroupState>();
	const idempotency = new Map<string, KafkaProduceResult>();
	let msgSeq = 0;
	let offsetSeq = 0;
	let leaseSeq = 0;

	const groupKey = (topic: string, group: string) => `${topic}::${group}`;
	const getGroup = (topic: string, group: string): GroupState => {
		const key = groupKey(topic, group);
		let g = groups.get(key);
		if (!g) {
			g = { acked: new Set(), inflight: new Map(), attempts: new Map() };
			groups.set(key, g);
		}
		return g;
	};

	const transport: KafkaBrokerTransport = {
		kind: "kafka-broker-transport",

		async ensureTopic(topic, opts) {
			const name = parseTopicName(String(topic));
			if (!logs.has(name)) {
				logs.set(name, []);
				partitions.set(name, opts?.partitions ?? defaultPartitions);
			}
		},

		async produce(request) {
			const topic = parseTopicName(String(request.topic));
			if (!logs.has(topic)) {
				await transport.ensureTopic(topic);
			}
			if (request.idempotencyKey) {
				const prior = idempotency.get(`${topic}::${request.idempotencyKey}`);
				if (prior) {
					return { ...prior, deduped: true };
				}
			}
			const partCount = partitions.get(topic) ?? defaultPartitions;
			const partition =
				request.key.length === 0
					? 0
					: Math.abs(hashString(request.key)) % partCount;
			const messageId = parseMessagingMessageId(`kmsg-${++msgSeq}`);
			const offset = ++offsetSeq;
			const publishedAt = now();
			const entry: LogEntry = {
				messageId,
				topic,
				key: request.key,
				body: request.body,
				headers: { ...request.headers },
				partition,
				offset,
				publishedAt,
				...(request.idempotencyKey
					? { idempotencyKey: request.idempotencyKey }
					: undefined),
			};
			mustGet(logs, topic).push(entry);
			const result: KafkaProduceResult = Object.freeze({
				messageId,
				topic,
				partition,
				offset,
				publishedAt,
				deduped: false,
			});
			if (request.idempotencyKey) {
				idempotency.set(`${topic}::${request.idempotencyKey}`, result);
			}
			return result;
		},

		async fetch(request) {
			const topic = parseTopicName(String(request.topic));
			const group = requireNonEmpty(request.consumerGroup, "consumerGroup");
			const max = Math.max(1, request.maxMessages);
			const log = logs.get(topic) ?? [];
			const cursor = getGroup(topic, group);
			const nowMs = Date.parse(now());
			const out: KafkaFetchedMessage[] = [];

			for (const entry of log) {
				if (out.length >= max) break;
				if (cursor.acked.has(entry.messageId)) continue;
				const inflight = cursor.inflight.get(entry.messageId);
				if (inflight && inflight.expiresAtMs > nowMs) continue;

				const attempt = (cursor.attempts.get(entry.messageId) ?? 0) + 1;
				cursor.attempts.set(entry.messageId, attempt);
				const leaseId = `klease-${++leaseSeq}`;
				cursor.inflight.set(entry.messageId, {
					leaseId,
					expiresAtMs: nowMs + 30_000,
					attempt,
				});
				out.push(
					Object.freeze({
						messageId: entry.messageId,
						topic,
						consumerGroup: group,
						body: entry.body,
						headers: entry.headers,
						offset: entry.offset,
						partition: entry.partition,
						deliveryAttempt: attempt,
						leaseId,
						receivedAt: now(),
					}),
				);
			}
			return out;
		},

		async commit(request) {
			const topic = parseTopicName(String(request.topic));
			const group = requireNonEmpty(request.consumerGroup, "consumerGroup");
			const cursor = getGroup(topic, group);
			const inflight = cursor.inflight.get(request.messageId);
			if (!inflight || inflight.leaseId !== request.leaseId) {
				throw new Error(
					`kafka transport commit lease mismatch for ${request.messageId}`,
				);
			}
			cursor.acked.add(request.messageId);
			cursor.inflight.delete(request.messageId);
		},

		async release(request) {
			const topic = parseTopicName(String(request.topic));
			const group = requireNonEmpty(request.consumerGroup, "consumerGroup");
			const cursor = getGroup(topic, group);
			const inflight = cursor.inflight.get(request.messageId);
			if (!inflight || inflight.leaseId !== request.leaseId) {
				throw new Error(
					`kafka transport release lease mismatch for ${request.messageId}`,
				);
			}
			cursor.inflight.delete(request.messageId);
		},
	};

	return Object.freeze(transport);
}

/**
 * Optional env-gated real broker probe. Returns a transport only when
 * HOBO_KAFKA_LIVE_TRANSPORT=memory (harness) or a bootstrap env is set and a
 * factory is injected — never fabricates live fidelity without a transport.
 */
export function resolveKafkaTransportFromEnv(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
	options: {
		readonly createLive?: (bootstrap: string[]) => KafkaBrokerTransport;
	} = {},
): KafkaBrokerTransport | undefined {
	if (env.HOBO_KAFKA_LIVE_TRANSPORT === "memory") {
		return createInMemoryKafkaTransport();
	}
	const raw =
		env.HOBO_REDPANDA_URL ||
		env.REDPANDA_BROKERS ||
		env.KAFKA_BOOTSTRAP_SERVERS;
	if (raw !== undefined && raw.length > 0 && options.createLive) {
		const servers = raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (servers.length > 0) {
			return options.createLive(servers);
		}
	}
	return undefined;
}

function requireNonEmpty(value: string, field: string): string {
	if (!value) {
		throw new MessagingParseError(field, "non-empty string", value);
	}
	return value;
}

function hashString(value: string): number {
	let h = 0;
	for (let i = 0; i < value.length; i++) {
		h = (h * 31 + value.charCodeAt(i)) | 0;
	}
	return h;
}
