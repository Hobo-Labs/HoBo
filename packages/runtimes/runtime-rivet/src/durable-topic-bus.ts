/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: persisted and incoming JSON are parsed and bounded before use. */
import { DURABLE_MESSAGING_LIMITS } from "@hobo/core";

export const RIVET_DURABLE_TOPIC_BUS_LIMITS = Object.freeze({
	...DURABLE_MESSAGING_LIMITS,
	payloadBytes: 8_192,
	attributeBytes: 2_048,
	batchSize: 4,
	retainedMessages: 64,
	retainedEvents: 128,
	topics: 32,
	subscriptions: 16,
});
export const RIVET_DURABLE_TOPIC_BUS_CAPABILITIES = Object.freeze({
	topicCreation: true,
	publish: true,
	readRetainedLog: false,
	compaction: true,
	auditEvents: true,
	consumerGroups: true,
	leases: true,
	acknowledgement: true,
	deadLetter: true,
	legacyWit: false,
});

type Attribute = { key: string; value: string };
type Topic = { name: string; floor: number; tail: number; truncated: boolean };
type DeadLetter = {
	sourceTopic: string;
	consumerGroup: string;
	originalMessageId: string;
	originalSequence: number;
	deliveryAttempt: number;
	cause: { kind: "nack"; reason: string } | { kind: "lease-expired" };
};
type Message = {
	topic: string;
	sequence: number;
	id: string;
	subject: string;
	payload: string;
	attributes: Attribute[];
	deadLetter?: DeadLetter;
};
type Subscription = {
	topic: string;
	consumerGroup: string;
	deadLetterTopic: string;
	maxDeliveryAttempts: number;
	startAt: "earliest" | "latest";
	startSequence: number;
	firstAvailableSequence: number;
	historyTruncated: boolean;
};
type DeliveryState = {
	subscription: number;
	sequence: number;
	attempt: number;
	lease: number;
	deadline: number;
	reserved: boolean;
	status: "pending" | "leased" | "settled";
};
type Event = {
	sequence: number;
	kind:
		| "topic-created"
		| "subscription-created"
		| "published"
		| "leased"
		| "acknowledged"
		| "released"
		| "dead-lettered"
		| "compacted";
	topic: string;
	messageId?: string;
	consumerGroup?: string;
};
type State = {
	version: 2;
	topics: Topic[];
	messages: Message[];
	subscriptions: Subscription[];
	deliveries: DeliveryState[];
	events: Event[];
	eventTail: number;
	leaseCounter: number;
	deadLetterCounter: number;
};
type Reject =
	| "invalid-argument"
	| "not-found"
	| "capacity-exceeded"
	| "message-conflict"
	| "subscription-conflict"
	| "lease-lost"
	| "retention-blocked"
	| "unsupported";
type Reduction =
	| { status: "committed"; value: string; state: string }
	| { status: "rejected"; code: Reject };
const encoder = new TextEncoder();
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysOnly(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return (
		actual.length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
function integer(value: unknown, min = 0): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= min
	);
}
function scalar(
	value: unknown,
	bytes: number,
	nonempty = false,
): value is string {
	return (
		typeof value === "string" &&
		(!nonempty || value.length > 0) &&
		value.length <= bytes &&
		!/[\uD800-\uDFFF]/u.test(value) &&
		encoder.encode(value).length <= bytes
	);
}
function name(value: unknown): value is string {
	return (
		scalar(value, RIVET_DURABLE_TOPIC_BUS_LIMITS.nameBytes, true) &&
		!/[\p{Cc}]/u.test(value)
	);
}
function attributes(value: unknown): value is Attribute[] {
	if (
		!Array.isArray(value) ||
		value.length > RIVET_DURABLE_TOPIC_BUS_LIMITS.attributeCount
	)
		return false;
	let size = 0;
	const keys = new Set<string>();
	for (const item of value) {
		if (
			!record(item) ||
			!keysOnly(item, ["key", "value"]) ||
			!scalar(item.key, RIVET_DURABLE_TOPIC_BUS_LIMITS.attributeBytes, true) ||
			!scalar(item.value, RIVET_DURABLE_TOPIC_BUS_LIMITS.attributeBytes) ||
			keys.has(item.key)
		)
			return false;
		keys.add(item.key);
		size += encoder.encode(item.key).length + encoder.encode(item.value).length;
		if (size > RIVET_DURABLE_TOPIC_BUS_LIMITS.attributeBytes) return false;
	}
	return true;
}
function payload(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length >
			Math.ceil(RIVET_DURABLE_TOPIC_BUS_LIMITS.payloadBytes / 3) * 4
	)
		return false;
	const bytes = Buffer.from(value, "base64");
	return (
		bytes.length <= RIVET_DURABLE_TOPIC_BUS_LIMITS.payloadBytes &&
		bytes.toString("base64") === value
	);
}
function message(value: unknown): value is {
	id: string;
	subject: string;
	payload: string;
	attributes: Attribute[];
} {
	return (
		record(value) &&
		name(value.id) &&
		name(value.subject) &&
		payload(value.payload) &&
		attributes(value.attributes)
	);
}
function empty(): State {
	return {
		version: 2,
		topics: [],
		messages: [],
		subscriptions: [],
		deliveries: [],
		events: [],
		eventTail: 0,
		leaseCounter: 0,
		deadLetterCounter: 0,
	};
}
function isDeadLetter(value: unknown): value is DeadLetter {
	if (
		!record(value) ||
		!keysOnly(value, [
			"sourceTopic",
			"consumerGroup",
			"originalMessageId",
			"originalSequence",
			"deliveryAttempt",
			"cause",
		]) ||
		!name(value.sourceTopic) ||
		!name(value.consumerGroup) ||
		!name(value.originalMessageId) ||
		!integer(value.originalSequence, 1) ||
		!integer(value.deliveryAttempt, 1) ||
		value.deliveryAttempt > RIVET_DURABLE_TOPIC_BUS_LIMITS.deliveryAttempts ||
		!record(value.cause)
	)
		return false;
	if (value.cause.kind === "lease-expired")
		return keysOnly(value.cause, ["kind"]);
	return (
		value.cause.kind === "nack" &&
		keysOnly(value.cause, ["kind", "reason"]) &&
		scalar(value.cause.reason, RIVET_DURABLE_TOPIC_BUS_LIMITS.reasonBytes)
	);
}
function stateFromJson(encoded: string | undefined): State {
	if (encoded === undefined) return empty();
	const value: unknown = JSON.parse(encoded);
	if (
		!record(value) ||
		!keysOnly(value, [
			"version",
			"topics",
			"messages",
			"subscriptions",
			"deliveries",
			"events",
			"eventTail",
			"leaseCounter",
			"deadLetterCounter",
		]) ||
		value.version !== 2 ||
		!Array.isArray(value.topics) ||
		value.topics.length > RIVET_DURABLE_TOPIC_BUS_LIMITS.topics ||
		!Array.isArray(value.messages) ||
		value.messages.length > RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedMessages ||
		!Array.isArray(value.subscriptions) ||
		value.subscriptions.length > RIVET_DURABLE_TOPIC_BUS_LIMITS.subscriptions ||
		!Array.isArray(value.deliveries) ||
		value.deliveries.length >
			RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedMessages *
				RIVET_DURABLE_TOPIC_BUS_LIMITS.subscriptions ||
		!Array.isArray(value.events) ||
		value.events.length > RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedEvents ||
		!integer(value.eventTail) ||
		!integer(value.leaseCounter) ||
		!integer(value.deadLetterCounter)
	)
		throw new Error("invalid bus state");
	const topics = new Map<string, Topic>();
	for (const item of value.topics) {
		if (
			!record(item) ||
			!keysOnly(item, ["name", "floor", "tail", "truncated"]) ||
			!name(item.name) ||
			!integer(item.floor, 1) ||
			!integer(item.tail) ||
			item.floor > item.tail + 1 ||
			typeof item.truncated !== "boolean" ||
			item.floor > 1 !== item.truncated ||
			topics.has(item.name)
		)
			throw new Error("invalid topic");
		topics.set(item.name, {
			name: item.name,
			floor: item.floor,
			tail: item.tail,
			truncated: item.truncated,
		});
	}
	const subscriptions: Subscription[] = [];
	const groupKeys = new Set<string>();
	for (const item of value.subscriptions) {
		if (
			!record(item) ||
			!keysOnly(item, [
				"topic",
				"consumerGroup",
				"deadLetterTopic",
				"maxDeliveryAttempts",
				"startAt",
				"startSequence",
				"firstAvailableSequence",
				"historyTruncated",
			]) ||
			!name(item.topic) ||
			!name(item.consumerGroup) ||
			!name(item.deadLetterTopic) ||
			item.topic === item.deadLetterTopic ||
			!integer(item.maxDeliveryAttempts, 1) ||
			item.maxDeliveryAttempts >
				RIVET_DURABLE_TOPIC_BUS_LIMITS.deliveryAttempts ||
			(item.startAt !== "earliest" && item.startAt !== "latest") ||
			!integer(item.startSequence, 1) ||
			!integer(item.firstAvailableSequence, 1) ||
			typeof item.historyTruncated !== "boolean" ||
			item.historyTruncated !== item.firstAvailableSequence > 1
		)
			throw new Error("invalid subscription");
		const topic = topics.get(item.topic);
		const key = JSON.stringify([item.topic, item.consumerGroup]);
		if (
			topic === undefined ||
			!topics.has(item.deadLetterTopic) ||
			groupKeys.has(key) ||
			item.firstAvailableSequence > topic.floor ||
			item.startSequence < item.firstAvailableSequence ||
			item.startSequence > topic.tail + 1 ||
			(item.startAt === "earliest" &&
				item.startSequence !== item.firstAvailableSequence)
		)
			throw new Error("invalid subscription checkpoint");
		groupKeys.add(key);
		subscriptions.push({
			topic: item.topic,
			consumerGroup: item.consumerGroup,
			deadLetterTopic: item.deadLetterTopic,
			maxDeliveryAttempts: item.maxDeliveryAttempts,
			startAt: item.startAt,
			startSequence: item.startSequence,
			firstAvailableSequence: item.firstAvailableSequence,
			historyTruncated: item.historyTruncated,
		});
	}
	const messages: Message[] = [];
	const ids = new Set<string>();
	const sequences = new Set<string>();
	const generatedIds = new Set<number>();
	const transferredOrigins = new Set<string>();
	for (const item of value.messages) {
		if (
			!record(item) ||
			!keysOnly(
				item,
				item.deadLetter === undefined
					? ["topic", "sequence", "id", "subject", "payload", "attributes"]
					: [
							"topic",
							"sequence",
							"id",
							"subject",
							"payload",
							"attributes",
							"deadLetter",
						],
			) ||
			!name(item.topic) ||
			!integer(item.sequence, 1)
		)
			throw new Error("invalid message");
		const topicName = item.topic;
		const sequence = item.sequence;
		const provenance = item.deadLetter;
		if (
			!message(item) ||
			(provenance !== undefined && !isDeadLetter(provenance))
		)
			throw new Error("invalid message contents");
		const topic = topics.get(topicName);
		const id = JSON.stringify([topicName, item.id]);
		const seq = JSON.stringify([topicName, sequence]);
		if (
			topic === undefined ||
			sequence < topic.floor ||
			sequence > topic.tail ||
			ids.has(id) ||
			sequences.has(seq)
		)
			throw new Error("invalid message identity");
		if (provenance !== undefined) {
			const origin = subscriptions.find(
				(sub) =>
					sub.topic === provenance.sourceTopic &&
					sub.consumerGroup === provenance.consumerGroup,
			);
			const sourceTopic = topics.get(provenance.sourceTopic);
			const generated = /^dlq-([1-9][0-9]{0,15})$/u.exec(item.id);
			const counter = generated === null ? 0 : Number(generated[1]);
			const originKey = JSON.stringify([
				provenance.sourceTopic,
				provenance.consumerGroup,
				provenance.originalSequence,
			]);
			if (
				origin === undefined ||
				sourceTopic === undefined ||
				origin.deadLetterTopic !== topicName ||
				provenance.deliveryAttempt !== origin.maxDeliveryAttempts ||
				provenance.originalSequence < origin.startSequence ||
				provenance.originalSequence > sourceTopic.tail ||
				generated === null ||
				!integer(counter, 1) ||
				String(counter) !== generated[1] ||
				counter > value.deadLetterCounter ||
				generatedIds.has(counter) ||
				transferredOrigins.has(originKey)
			)
				throw new Error("invalid dead letter provenance");
			generatedIds.add(counter);
			transferredOrigins.add(originKey);
		}
		ids.add(id);
		sequences.add(seq);
		const entry: Message = {
			topic: topicName,
			sequence,
			id: item.id,
			subject: item.subject,
			payload: item.payload,
			attributes: item.attributes.map((attr) => ({
				key: attr.key,
				value: attr.value,
			})),
		};
		if (provenance !== undefined) entry.deadLetter = provenance;
		messages.push(entry);
	}
	for (const topic of topics.values())
		if (
			messages.filter((entry) => entry.topic === topic.name).length !==
			topic.tail - topic.floor + 1
		)
			throw new Error("missing message history");
	const deliveries: DeliveryState[] = [];
	const deliveryKeys = new Set<string>();
	const activeLeases = new Set<number>();
	for (const item of value.deliveries) {
		if (
			!record(item) ||
			!keysOnly(item, [
				"subscription",
				"sequence",
				"attempt",
				"lease",
				"deadline",
				"reserved",
				"status",
			]) ||
			!integer(item.subscription) ||
			!integer(item.sequence, 1) ||
			!integer(item.attempt) ||
			!integer(item.lease) ||
			!integer(item.deadline) ||
			typeof item.reserved !== "boolean" ||
			(item.status !== "pending" &&
				item.status !== "leased" &&
				item.status !== "settled")
		)
			throw new Error("invalid delivery");
		const sub = subscriptions[item.subscription];
		const key = JSON.stringify([item.subscription, item.sequence]);
		const source =
			sub === undefined
				? undefined
				: messages.find(
						(entry) =>
							entry.topic === sub.topic && entry.sequence === item.sequence,
					);
		if (
			sub === undefined ||
			item.sequence < sub.startSequence ||
			!sequences.has(JSON.stringify([sub.topic, item.sequence])) ||
			deliveryKeys.has(key) ||
			item.attempt > sub.maxDeliveryAttempts ||
			item.lease > value.leaseCounter ||
			(item.status === "pending" &&
				(item.lease !== 0 ||
					item.deadline !== 0 ||
					item.attempt >= sub.maxDeliveryAttempts ||
					(!item.reserved &&
						(item.attempt !== 0 || source?.deadLetter === undefined)))) ||
			(item.status === "leased" &&
				(item.attempt === 0 ||
					!item.reserved ||
					item.lease === 0 ||
					item.deadline === 0 ||
					activeLeases.has(item.lease))) ||
			(item.status === "settled" &&
				(item.attempt === 0 ||
					item.lease !== 0 ||
					item.deadline !== 0 ||
					item.reserved))
		)
			throw new Error("invalid delivery state");
		if (item.status === "leased") activeLeases.add(item.lease);
		deliveryKeys.add(key);
		deliveries.push({
			subscription: item.subscription,
			sequence: item.sequence,
			attempt: item.attempt,
			lease: item.lease,
			deadline: item.deadline,
			reserved: item.reserved,
			status: item.status,
		});
	}
	if (
		messages.length + deliveries.filter((item) => item.reserved).length >
		RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedMessages
	)
		throw new Error("invalid reserved capacity");
	for (const [index, sub] of subscriptions.entries())
		for (const item of messages) {
			if (
				item.topic === sub.topic &&
				item.sequence >= sub.startSequence &&
				!deliveryKeys.has(JSON.stringify([index, item.sequence]))
			)
				throw new Error("missing group obligation");
		}
	for (const item of messages) {
		const provenance = item.deadLetter;
		if (provenance === undefined) continue;
		const source = messages.find(
			(entry) =>
				entry.topic === provenance.sourceTopic &&
				entry.sequence === provenance.originalSequence,
		);
		if (source === undefined) continue;
		const subscription = subscriptions.findIndex(
			(entry) =>
				entry.topic === provenance.sourceTopic &&
				entry.consumerGroup === provenance.consumerGroup,
		);
		const delivery = deliveries.find(
			(entry) =>
				entry.subscription === subscription &&
				entry.sequence === source.sequence,
		);
		if (
			source.id !== provenance.originalMessageId ||
			source.subject !== item.subject ||
			source.payload !== item.payload ||
			source.attributes.length !== item.attributes.length ||
			!source.attributes.every(
				(attribute, index) =>
					attribute.key === item.attributes[index]?.key &&
					attribute.value === item.attributes[index]?.value,
			) ||
			delivery?.status !== "settled" ||
			delivery.attempt !== provenance.deliveryAttempt
		)
			throw new Error("dead letter does not match retained source");
	}
	const events: Event[] = [];
	if (
		value.events.length !==
		Math.min(value.eventTail, RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedEvents)
	)
		throw new Error("missing audit events");
	for (const [index, item] of value.events.entries()) {
		if (
			!record(item) ||
			!integer(item.sequence, 1) ||
			item.sequence !== value.eventTail - value.events.length + index + 1 ||
			!name(item.topic) ||
			!topics.has(item.topic)
		)
			throw new Error("invalid event");
		const groupEvent =
			item.kind === "subscription-created" ||
			item.kind === "leased" ||
			item.kind === "acknowledged" ||
			item.kind === "released" ||
			item.kind === "dead-lettered";
		const messageEvent =
			item.kind === "published" ||
			item.kind === "leased" ||
			item.kind === "acknowledged" ||
			item.kind === "released" ||
			item.kind === "dead-lettered";
		if (
			item.kind !== "topic-created" &&
			item.kind !== "compacted" &&
			item.kind !== "subscription-created" &&
			item.kind !== "leased" &&
			item.kind !== "acknowledged" &&
			item.kind !== "released" &&
			item.kind !== "dead-lettered" &&
			item.kind !== "published"
		)
			throw new Error("invalid event kind");
		const keys = ["sequence", "kind", "topic"];
		if (groupEvent) keys.push("consumerGroup");
		if (messageEvent) keys.push("messageId");
		if (
			!keysOnly(item, keys) ||
			(groupEvent && !name(item.consumerGroup)) ||
			(messageEvent && !name(item.messageId))
		)
			throw new Error("invalid event fields");
		if (
			groupEvent &&
			!groupKeys.has(JSON.stringify([item.topic, item.consumerGroup]))
		)
			throw new Error("unknown event group");
		const entry: Event = {
			sequence: item.sequence,
			kind: item.kind,
			topic: item.topic,
		};
		if (name(item.consumerGroup)) entry.consumerGroup = item.consumerGroup;
		if (name(item.messageId)) entry.messageId = item.messageId;
		events.push(entry);
	}
	return {
		version: 2,
		topics: [...topics.values()],
		messages,
		subscriptions,
		deliveries,
		events,
		eventTail: value.eventTail,
		leaseCounter: value.leaseCounter,
		deadLetterCounter: value.deadLetterCounter,
	};
}
function event(
	state: State,
	kind: Event["kind"],
	topic: string,
	messageId?: string,
	consumerGroup?: string,
): void {
	if (state.eventTail >= Number.MAX_SAFE_INTEGER) throw new CapacityError();
	const item: Event = {
		sequence: ++state.eventTail,
		kind,
		topic,
	};
	if (messageId !== undefined) item.messageId = messageId;
	if (consumerGroup !== undefined) item.consumerGroup = consumerGroup;
	state.events.push(item);
	if (state.events.length > RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedEvents)
		state.events.shift();
}
function committed(
	state: State,
	value: Record<string, unknown> | readonly object[],
): Reduction {
	return {
		status: "committed",
		value: JSON.stringify(value),
		state: JSON.stringify(state),
	};
}
function rejected(code: Reject): Reduction {
	return { status: "rejected", code };
}
class CapacityError extends Error {}
function reserveCapacity(
	state: State,
	messages: number,
	obligations: number,
): void {
	const reserved = state.deliveries.filter((item) => item.reserved).length;
	if (
		state.messages.length + reserved + messages + obligations >
		RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedMessages
	)
		throw new CapacityError();
}
function addObligations(
	state: State,
	topic: string,
	sequence: number,
	reserved: boolean,
): void {
	for (const [index, sub] of state.subscriptions.entries()) {
		if (sub.topic === topic && sequence >= sub.startSequence)
			state.deliveries.push({
				subscription: index,
				sequence,
				attempt: 0,
				lease: 0,
				deadline: 0,
				reserved,
				status: "pending",
			});
	}
}
function transfer(
	state: State,
	sub: Subscription,
	delivery: DeliveryState,
	source: Message,
	cause: DeadLetter["cause"],
) {
	const topic = state.topics.find((item) => item.name === sub.deadLetterTopic);
	if (topic === undefined) throw new Error("missing dead letter topic");
	if (!delivery.reserved) throw new Error("unreserved transfer");
	if (
		state.messages.length >= RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedMessages ||
		topic.tail >= Number.MAX_SAFE_INTEGER
	)
		throw new CapacityError();
	let id = "";
	for (
		let count = 0;
		count <= RIVET_DURABLE_TOPIC_BUS_LIMITS.retainedMessages;
		count++
	) {
		if (state.deadLetterCounter >= Number.MAX_SAFE_INTEGER)
			throw new CapacityError();
		id = `dlq-${++state.deadLetterCounter}`;
		if (
			!state.messages.some(
				(item) => item.topic === topic.name && item.id === id,
			)
		)
			break;
		id = "";
	}
	if (id === "") throw new CapacityError();
	const sequence = ++topic.tail;
	state.messages.push({
		topic: topic.name,
		sequence,
		id,
		subject: source.subject,
		payload: source.payload,
		attributes: source.attributes.map((entry) => ({ ...entry })),
		deadLetter: {
			sourceTopic: sub.topic,
			consumerGroup: sub.consumerGroup,
			originalMessageId: source.id,
			originalSequence: source.sequence,
			deliveryAttempt: delivery.attempt,
			cause,
		},
	});
	addObligations(state, topic.name, sequence, false);
	delivery.status = "settled";
	delivery.reserved = false;
	delivery.lease = 0;
	delivery.deadline = 0;
	event(state, "dead-lettered", sub.topic, source.id, sub.consumerGroup);
	event(state, "published", topic.name, id);
	return { id, sequence };
}

export function reduceRivetTopicBusWithDeclaredTopics(
	prior: string | undefined,
	method: string,
	input: unknown,
	now: number,
	topics: readonly string[],
): Reduction {
	let state = prior;
	if (state === undefined) {
		for (const topic of topics) {
			const initialized = reduceRivetTopicBus(
				state,
				"ensure-topic",
				{ operation: {}, topic },
				now,
			);
			if (initialized.status !== "committed") return initialized;
			state = initialized.state;
		}
	} else {
		const existing = stateFromJson(state);
		if (
			topics.some(
				(topic) => !existing.topics.some((entry) => entry.name === topic),
			)
		)
			throw new Error("declared topic missing from persisted state");
	}
	return reduceRivetTopicBus(state, method, input, now);
}

export function reduceRivetTopicBus(
	prior: string | undefined,
	method: string,
	input: unknown,
	now: number,
): Reduction {
	const state = stateFromJson(prior);
	if (!record(input)) return rejected("invalid-argument");
	if (Object.hasOwn(input, "__hobo_invalid_request"))
		return rejected("invalid-argument");
	if (!integer(now)) throw new Error("invalid trusted time");
	try {
		if (method === "ensure-topic") {
			if (!keysOnly(input, ["operation", "topic"]) || !name(input.topic))
				return rejected("invalid-argument");
			if (!state.topics.some((topic) => topic.name === input.topic)) {
				if (state.topics.length >= RIVET_DURABLE_TOPIC_BUS_LIMITS.topics)
					throw new CapacityError();
				state.topics.push({
					name: input.topic,
					floor: 1,
					tail: 0,
					truncated: false,
				});
				event(state, "topic-created", input.topic);
			}
			return committed(state, { topic: input.topic });
		}
		if (method === "ensure-subscription") {
			const sub = input.subscription;
			if (
				!keysOnly(input, ["operation", "subscription"]) ||
				!record(sub) ||
				!keysOnly(sub, [
					"topic",
					"consumerGroup",
					"deadLetterTopic",
					"maxDeliveryAttempts",
					"startAt",
				]) ||
				!name(sub.topic) ||
				!name(sub.consumerGroup) ||
				!name(sub.deadLetterTopic) ||
				sub.topic === sub.deadLetterTopic ||
				!integer(sub.maxDeliveryAttempts, 1) ||
				sub.maxDeliveryAttempts >
					RIVET_DURABLE_TOPIC_BUS_LIMITS.deliveryAttempts ||
				(sub.startAt !== "earliest" && sub.startAt !== "latest")
			)
				return rejected("invalid-argument");
			const topic = state.topics.find((item) => item.name === sub.topic);
			if (
				topic === undefined ||
				!state.topics.some((item) => item.name === sub.deadLetterTopic)
			)
				return rejected("not-found");
			const old = state.subscriptions.find(
				(item) =>
					item.topic === sub.topic && item.consumerGroup === sub.consumerGroup,
			);
			if (old !== undefined) {
				if (
					old.deadLetterTopic !== sub.deadLetterTopic ||
					old.maxDeliveryAttempts !== sub.maxDeliveryAttempts ||
					old.startAt !== sub.startAt
				)
					return rejected("subscription-conflict");
				return committed(state, {
					subscription: {
						topic: old.topic,
						consumerGroup: old.consumerGroup,
						deadLetterTopic: old.deadLetterTopic,
						maxDeliveryAttempts: old.maxDeliveryAttempts,
						startAt: old.startAt,
					},
					firstAvailableSequence: old.firstAvailableSequence,
					historyTruncated: old.historyTruncated,
				});
			}
			if (
				state.subscriptions.length >=
					RIVET_DURABLE_TOPIC_BUS_LIMITS.subscriptions ||
				(sub.startAt === "latest" && topic.tail >= Number.MAX_SAFE_INTEGER)
			)
				throw new CapacityError();
			const startSequence =
				sub.startAt === "earliest" ? topic.floor : topic.tail + 1;
			reserveCapacity(
				state,
				0,
				state.messages.filter(
					(item) => item.topic === sub.topic && item.sequence >= startSequence,
				).length,
			);
			const index = state.subscriptions.length;
			state.subscriptions.push({
				topic: sub.topic,
				consumerGroup: sub.consumerGroup,
				deadLetterTopic: sub.deadLetterTopic,
				maxDeliveryAttempts: sub.maxDeliveryAttempts,
				startAt: sub.startAt,
				startSequence,
				firstAvailableSequence: topic.floor,
				historyTruncated: topic.truncated,
			});
			for (const item of state.messages)
				if (item.topic === sub.topic && item.sequence >= startSequence)
					state.deliveries.push({
						subscription: index,
						sequence: item.sequence,
						attempt: 0,
						lease: 0,
						deadline: 0,
						reserved: true,
						status: "pending",
					});
			event(
				state,
				"subscription-created",
				sub.topic,
				undefined,
				sub.consumerGroup,
			);
			return committed(state, {
				subscription: sub,
				firstAvailableSequence: topic.floor,
				historyTruncated: topic.truncated,
			});
		}
		if (method === "publish") {
			const submitted = input.message;
			if (
				!keysOnly(input, ["operation", "topic", "message"]) ||
				!name(input.topic) ||
				!record(submitted) ||
				!keysOnly(submitted, ["id", "subject", "payload", "attributes"]) ||
				!message(submitted)
			)
				return rejected("invalid-argument");
			const topic = state.topics.find((item) => item.name === input.topic);
			if (topic === undefined) return rejected("not-found");
			if (
				state.messages.some(
					(item) => item.topic === topic.name && item.id === submitted.id,
				)
			)
				return rejected("message-conflict");
			if (topic.tail >= Number.MAX_SAFE_INTEGER) throw new CapacityError();
			reserveCapacity(
				state,
				1,
				state.subscriptions.filter((item) => item.topic === topic.name).length,
			);
			const sequence = ++topic.tail;
			state.messages.push({
				topic: topic.name,
				sequence,
				id: submitted.id,
				subject: submitted.subject,
				payload: submitted.payload,
				attributes: submitted.attributes.map((item) => ({
					key: item.key,
					value: item.value,
				})),
			});
			addObligations(state, topic.name, sequence, true);
			event(state, "published", topic.name, submitted.id);
			return committed(state, { messageId: submitted.id, sequence });
		}
		if (method === "consume") {
			if (
				!keysOnly(input, [
					"operation",
					"topic",
					"consumerGroup",
					"maxMessages",
					"visibilityTimeoutMs",
				]) ||
				!name(input.topic) ||
				!name(input.consumerGroup) ||
				!integer(input.maxMessages, 1) ||
				input.maxMessages > RIVET_DURABLE_TOPIC_BUS_LIMITS.batchSize ||
				!integer(input.visibilityTimeoutMs, 1) ||
				input.visibilityTimeoutMs > RIVET_DURABLE_TOPIC_BUS_LIMITS.leaseMs
			)
				return rejected("invalid-argument");
			const index = state.subscriptions.findIndex(
				(item) =>
					item.topic === input.topic &&
					item.consumerGroup === input.consumerGroup,
			);
			const sub = state.subscriptions[index];
			if (sub === undefined) return rejected("not-found");
			if (now > Number.MAX_SAFE_INTEGER - input.visibilityTimeoutMs)
				throw new CapacityError();
			const deadline = now + input.visibilityTimeoutMs;
			let transferred = false;
			for (const delivery of state.deliveries) {
				if (
					delivery.subscription !== index ||
					delivery.status !== "leased" ||
					delivery.deadline > now ||
					delivery.attempt < sub.maxDeliveryAttempts
				)
					continue;
				const source = state.messages.find(
					(item) =>
						item.topic === sub.topic && item.sequence === delivery.sequence,
				);
				if (source === undefined) throw new Error("missing source");
				transfer(state, sub, delivery, source, { kind: "lease-expired" });
				transferred = true;
			}
			const result: Array<Record<string, unknown>> = [];
			const candidates = state.deliveries
				.filter((item) => item.subscription === index)
				.sort((a, b) => a.sequence - b.sequence);
			for (const delivery of candidates) {
				if (result.length >= input.maxMessages) break;
				if (
					delivery.status === "settled" ||
					(delivery.status === "leased" && delivery.deadline > now)
				)
					continue;
				if (
					state.leaseCounter >= Number.MAX_SAFE_INTEGER ||
					delivery.attempt >= sub.maxDeliveryAttempts
				) {
					if (result.length > 0 || transferred) break;
					throw new CapacityError();
				}
				if (!delivery.reserved) {
					try {
						reserveCapacity(state, 0, 1);
					} catch (error) {
						if (!(error instanceof CapacityError)) throw error;
						if (result.length > 0 || transferred) break;
						throw error;
					}
					delivery.reserved = true;
				}
				const source = state.messages.find(
					(item) =>
						item.topic === sub.topic && item.sequence === delivery.sequence,
				);
				if (source === undefined) throw new Error("missing source");
				delivery.status = "leased";
				delivery.lease = ++state.leaseCounter;
				delivery.deadline = deadline;
				delivery.attempt++;
				const output = {
					message: {
						id: source.id,
						subject: source.subject,
						payload: source.payload,
						attributes: source.attributes,
					},
					sequence: source.sequence,
					topic: sub.topic,
					consumerGroup: sub.consumerGroup,
					leaseId: `l${delivery.lease}`,
					leaseExpiresAtMs: deadline,
					deliveryAttempt: delivery.attempt,
				};
				if (source.deadLetter !== undefined)
					result.push({ ...output, deadLetter: source.deadLetter });
				else result.push(output);
				event(state, "leased", sub.topic, source.id, sub.consumerGroup);
			}
			return committed(state, result);
		}
		if (method === "ack" || method === "nack") {
			const expected = [
				"operation",
				"topic",
				"consumerGroup",
				"messageId",
				"sequence",
				"leaseId",
			];
			if (method === "nack") expected.push("reason");
			if (
				!keysOnly(input, expected) ||
				!name(input.topic) ||
				!name(input.consumerGroup) ||
				!name(input.messageId) ||
				!integer(input.sequence, 1) ||
				!name(input.leaseId) ||
				(method === "nack" &&
					!scalar(input.reason, RIVET_DURABLE_TOPIC_BUS_LIMITS.reasonBytes))
			)
				return rejected("invalid-argument");
			const index = state.subscriptions.findIndex(
				(item) =>
					item.topic === input.topic &&
					item.consumerGroup === input.consumerGroup,
			);
			const sub = state.subscriptions[index];
			if (sub === undefined) return rejected("not-found");
			const source = state.messages.find(
				(item) =>
					item.topic === sub.topic &&
					item.sequence === input.sequence &&
					item.id === input.messageId,
			);
			const delivery = state.deliveries.find(
				(item) =>
					item.subscription === index && item.sequence === input.sequence,
			);
			if (
				source === undefined ||
				delivery === undefined ||
				delivery.status !== "leased" ||
				delivery.deadline <= now ||
				`l${delivery.lease}` !== input.leaseId
			)
				return rejected("lease-lost");
			if (method === "ack") {
				delivery.status = "settled";
				delivery.reserved = false;
				delivery.lease = 0;
				delivery.deadline = 0;
				event(state, "acknowledged", sub.topic, source.id, sub.consumerGroup);
				return committed(state, {
					messageId: source.id,
					sequence: source.sequence,
				});
			}
			if (delivery.attempt < sub.maxDeliveryAttempts) {
				delivery.status = "pending";
				delivery.lease = 0;
				delivery.deadline = 0;
				event(state, "released", sub.topic, source.id, sub.consumerGroup);
				return committed(state, {
					messageId: source.id,
					sequence: source.sequence,
					disposition: "released",
				});
			}
			if (typeof input.reason !== "string") throw new Error("invalid reason");
			const transferred = transfer(state, sub, delivery, source, {
				kind: "nack",
				reason: input.reason,
			});
			return committed(state, {
				messageId: source.id,
				sequence: source.sequence,
				disposition: "dead-lettered",
				deadLetterMessageId: transferred.id,
				deadLetterSequence: transferred.sequence,
			});
		}
		if (method === "compact") {
			if (
				!keysOnly(input, ["operation", "topic", "throughSequence"]) ||
				!name(input.topic) ||
				!integer(input.throughSequence)
			)
				return rejected("invalid-argument");
			const through = input.throughSequence;
			const topic = state.topics.find((item) => item.name === input.topic);
			if (topic === undefined) return rejected("not-found");
			if (through > topic.tail) return rejected("invalid-argument");
			if (
				state.deliveries.some(
					(delivery) =>
						state.subscriptions[delivery.subscription]?.topic === topic.name &&
						delivery.sequence <= through &&
						delivery.status !== "settled",
				)
			)
				return rejected("retention-blocked");
			if (through >= topic.floor && through >= Number.MAX_SAFE_INTEGER)
				throw new CapacityError();
			const before = state.messages.length;
			state.messages = state.messages.filter(
				(item) => item.topic !== topic.name || item.sequence > through,
			);
			state.deliveries = state.deliveries.filter(
				(item) =>
					state.subscriptions[item.subscription]?.topic !== topic.name ||
					item.sequence > through,
			);
			const removedMessages = before - state.messages.length;
			if (removedMessages > 0) {
				topic.floor = through + 1;
				topic.truncated = true;
				event(state, "compacted", topic.name);
			}
			return committed(state, {
				topic: topic.name,
				firstAvailableSequence: topic.floor,
				removedMessages,
			});
		}
		return rejected("unsupported");
	} catch (error) {
		if (error instanceof CapacityError) return rejected("capacity-exceeded");
		throw error;
	}
}
export function readRivetTopicBusLog(
	prior: string | undefined,
	input: unknown,
) {
	const state = stateFromJson(prior);
	if (
		!record(input) ||
		!keysOnly(input, ["topic", "afterSequence", "limit"]) ||
		!name(input.topic) ||
		!integer(input.afterSequence) ||
		!integer(input.limit, 1) ||
		input.limit > RIVET_DURABLE_TOPIC_BUS_LIMITS.batchSize
	)
		return { status: "rejected", code: "invalid-argument" };
	const topic = state.topics.find((item) => item.name === input.topic);
	if (topic === undefined) return { status: "rejected", code: "not-found" };
	if (input.afterSequence > topic.tail)
		return { status: "rejected", code: "invalid-argument" };
	if (input.afterSequence < topic.floor - 1)
		return {
			status: "gap",
			firstAvailableSequence: topic.floor,
			latestSequence: topic.tail,
		};
	const afterSequence = input.afterSequence;
	const messages = state.messages
		.filter(
			(entry) => entry.topic === topic.name && entry.sequence > afterSequence,
		)
		.sort((a, b) => a.sequence - b.sequence)
		.slice(0, input.limit);
	const nextAfterSequence =
		messages[messages.length - 1]?.sequence ?? input.afterSequence;
	return {
		status: "ok",
		messages,
		firstAvailableSequence: topic.floor,
		nextAfterSequence,
		hasMore: nextAfterSequence < topic.tail,
	};
}

export function readRivetTopicBusAudit(
	prior: string | undefined,
	input: unknown,
) {
	const state = stateFromJson(prior);
	if (
		!record(input) ||
		!keysOnly(input, ["afterSequence", "limit"]) ||
		!integer(input.afterSequence) ||
		!integer(input.limit, 1) ||
		input.limit > RIVET_DURABLE_TOPIC_BUS_LIMITS.eventPageSize ||
		input.afterSequence > state.eventTail
	)
		return { status: "rejected", code: "invalid-argument" };
	const floor = state.eventTail - state.events.length + 1;
	if (input.afterSequence < floor - 1)
		return {
			status: "gap",
			firstAvailableSequence: floor,
			latestSequence: state.eventTail,
		};
	const afterSequence = input.afterSequence;
	const events = state.events
		.filter((entry) => entry.sequence > afterSequence)
		.slice(0, input.limit);
	const nextAfterSequence =
		events[events.length - 1]?.sequence ?? input.afterSequence;
	return {
		status: "ok",
		events,
		firstAvailableSequence: floor,
		nextAfterSequence,
		hasMore: nextAfterSequence < state.eventTail,
	};
}
