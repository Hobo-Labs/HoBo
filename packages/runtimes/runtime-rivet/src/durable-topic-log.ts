/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: persisted and incoming JSON are parsed and bounded before use. */
import { DURABLE_MESSAGING_LIMITS } from "@hobo/core";

export const RIVET_DURABLE_TOPIC_LOG_LIMITS = Object.freeze({
	...DURABLE_MESSAGING_LIMITS,
	payloadBytes: 8_192,
	attributeBytes: 2_048,
	batchSize: 4,
	retainedMessages: 128,
	retainedEvents: 128,
	topics: 32,
	subscriptions: 16,
});
export const RIVET_DURABLE_TOPIC_LOG_CAPABILITIES = Object.freeze({
	topicCreation: true,
	publish: true,
	readRetainedLog: true,
	compaction: true,
	auditEvents: true,
	consumerGroups: false,
	leases: false,
	acknowledgement: false,
	deadLetter: false,
	legacyWit: false,
});

type Attribute = { key: string; value: string };
type Topic = { name: string; floor: number; tail: number; truncated: boolean };
type Message = {
	topic: string;
	sequence: number;
	id: string;
	subject: string;
	payload: string;
	attributes: Attribute[];
};
type Event = {
	sequence: number;
	kind: "topic-created" | "published" | "compacted";
	topic: string;
	messageId?: string;
};
type State = {
	version: 1;
	topics: Topic[];
	messages: Message[];
	events: Event[];
	eventTail: number;
};
type Reject =
	| "invalid-argument"
	| "not-found"
	| "capacity-exceeded"
	| "message-conflict"
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
		scalar(value, RIVET_DURABLE_TOPIC_LOG_LIMITS.nameBytes, true) &&
		!/[\p{Cc}]/u.test(value)
	);
}
function attributes(value: unknown): value is Attribute[] {
	if (
		!Array.isArray(value) ||
		value.length > RIVET_DURABLE_TOPIC_LOG_LIMITS.attributeCount
	)
		return false;
	let size = 0;
	const keys = new Set<string>();
	for (const item of value) {
		if (
			!record(item) ||
			!keysOnly(item, ["key", "value"]) ||
			!scalar(item.key, RIVET_DURABLE_TOPIC_LOG_LIMITS.attributeBytes, true) ||
			!scalar(item.value, RIVET_DURABLE_TOPIC_LOG_LIMITS.attributeBytes) ||
			keys.has(item.key)
		)
			return false;
		keys.add(item.key);
		size += encoder.encode(item.key).length + encoder.encode(item.value).length;
		if (size > RIVET_DURABLE_TOPIC_LOG_LIMITS.attributeBytes) return false;
	}
	return true;
}
function payload(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length >
			Math.ceil(RIVET_DURABLE_TOPIC_LOG_LIMITS.payloadBytes / 3) * 4
	)
		return false;
	const bytes = Buffer.from(value, "base64");
	return (
		bytes.length <= RIVET_DURABLE_TOPIC_LOG_LIMITS.payloadBytes &&
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
	return { version: 1, topics: [], messages: [], events: [], eventTail: 0 };
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
			"events",
			"eventTail",
		]) ||
		value.version !== 1 ||
		!Array.isArray(value.topics) ||
		value.topics.length > RIVET_DURABLE_TOPIC_LOG_LIMITS.topics ||
		!Array.isArray(value.messages) ||
		value.messages.length > RIVET_DURABLE_TOPIC_LOG_LIMITS.retainedMessages ||
		!Array.isArray(value.events) ||
		value.events.length > RIVET_DURABLE_TOPIC_LOG_LIMITS.retainedEvents ||
		!integer(value.eventTail)
	)
		throw new Error("invalid topic state");
	const topics = new Map<string, Topic>();
	for (const item of value.topics) {
		if (
			!record(item) ||
			!keysOnly(item, ["name", "floor", "tail", "truncated"]) ||
			!name(item.name) ||
			!integer(item.floor, 1) ||
			!integer(item.tail) ||
			item.floor > item.tail + 1 ||
			item.floor > 1 !== item.truncated ||
			typeof item.truncated !== "boolean" ||
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
	const messages: Message[] = [];
	const ids = new Set<string>();
	const sequences = new Set<string>();
	for (const item of value.messages) {
		if (
			!record(item) ||
			!keysOnly(item, [
				"topic",
				"sequence",
				"id",
				"subject",
				"payload",
				"attributes",
			]) ||
			!name(item.topic) ||
			!integer(item.sequence, 1)
		)
			throw new Error("invalid message");
		const topicName = item.topic;
		const sequence = item.sequence;
		if (!message(item)) throw new Error("invalid message");
		const topic = topics.get(topicName);
		if (topic === undefined || sequence < topic.floor || sequence > topic.tail)
			throw new Error("invalid message sequence");
		const key = JSON.stringify([topicName, item.id]);
		const seq = JSON.stringify([topicName, sequence]);
		if (ids.has(key) || sequences.has(seq))
			throw new Error("duplicate message");
		ids.add(key);
		sequences.add(seq);
		messages.push({
			topic: topicName,
			sequence,
			id: item.id,
			subject: item.subject,
			payload: item.payload,
			attributes: item.attributes.map((entry) => ({
				key: entry.key,
				value: entry.value,
			})),
		});
	}
	for (const topic of topics.values())
		if (
			messages.filter((entry) => entry.topic === topic.name).length !==
			topic.tail - topic.floor + 1
		)
			throw new Error("missing topic history");
	const events: Event[] = [];
	if (
		value.events.length !==
		Math.min(value.eventTail, RIVET_DURABLE_TOPIC_LOG_LIMITS.retainedEvents)
	)
		throw new Error("missing audit events");
	for (const [index, item] of value.events.entries()) {
		if (
			!record(item) ||
			!keysOnly(
				item,
				item.kind === "published"
					? ["sequence", "kind", "topic", "messageId"]
					: ["sequence", "kind", "topic"],
			) ||
			!integer(item.sequence, 1) ||
			item.sequence !== value.eventTail - value.events.length + index + 1 ||
			!name(item.topic) ||
			!topics.has(item.topic) ||
			(item.kind !== "topic-created" &&
				item.kind !== "published" &&
				item.kind !== "compacted") ||
			(item.kind === "published" && !name(item.messageId))
		)
			throw new Error("invalid audit event");
		if (item.kind === "published") {
			if (!name(item.messageId)) throw new Error("invalid audit message");
			events.push({
				sequence: item.sequence,
				kind: item.kind,
				topic: item.topic,
				messageId: item.messageId,
			});
		} else
			events.push({
				sequence: item.sequence,
				kind: item.kind,
				topic: item.topic,
			});
	}
	return {
		version: 1,
		topics: [...topics.values()],
		messages,
		events,
		eventTail: value.eventTail,
	};
}
function event(
	state: State,
	kind: Event["kind"],
	topic: string,
	messageId?: string,
): void {
	if (state.eventTail >= Number.MAX_SAFE_INTEGER)
		throw new RangeError("audit sequence exhausted");
	const entry: Event = {
		sequence: ++state.eventTail,
		kind,
		topic,
	};
	if (messageId !== undefined) entry.messageId = messageId;
	state.events.push(entry);
	if (state.events.length > RIVET_DURABLE_TOPIC_LOG_LIMITS.retainedEvents)
		state.events.shift();
}
function committed(state: State, value: Record<string, unknown>): Reduction {
	return {
		status: "committed",
		value: JSON.stringify(value),
		state: JSON.stringify(state),
	};
}
function rejected(code: Reject): Reduction {
	return { status: "rejected", code };
}

export function reduceRivetTopicLog(
	prior: string | undefined,
	method: string,
	input: unknown,
): Reduction {
	const state = stateFromJson(prior);
	if (!record(input)) return rejected("invalid-argument");
	if (method === "ensure-topic") {
		if (!keysOnly(input, ["operation", "topic"]) || !name(input.topic))
			return rejected("invalid-argument");
		if (!state.topics.some((topic) => topic.name === input.topic)) {
			if (
				state.topics.length >= RIVET_DURABLE_TOPIC_LOG_LIMITS.topics ||
				state.eventTail >= Number.MAX_SAFE_INTEGER
			)
				return rejected("capacity-exceeded");
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
				(entry) => entry.topic === topic.name && entry.id === submitted.id,
			)
		)
			return rejected("message-conflict");
		if (
			state.messages.length >=
				RIVET_DURABLE_TOPIC_LOG_LIMITS.retainedMessages ||
			topic.tail >= Number.MAX_SAFE_INTEGER ||
			state.eventTail >= Number.MAX_SAFE_INTEGER
		)
			return rejected("capacity-exceeded");
		const next = ++topic.tail;
		state.messages.push({
			topic: topic.name,
			sequence: next,
			id: submitted.id,
			subject: submitted.subject,
			payload: submitted.payload,
			attributes: submitted.attributes.map((entry) => ({
				key: entry.key,
				value: entry.value,
			})),
		});
		event(state, "published", topic.name, submitted.id);
		return committed(state, { messageId: submitted.id, sequence: next });
	}
	if (method === "compact") {
		if (
			!keysOnly(input, ["operation", "topic", "throughSequence"]) ||
			!name(input.topic) ||
			!integer(input.throughSequence)
		)
			return rejected("invalid-argument");
		const throughSequence = input.throughSequence;
		const topic = state.topics.find((item) => item.name === input.topic);
		if (topic === undefined) return rejected("not-found");
		if (throughSequence > topic.tail) return rejected("invalid-argument");
		if (
			throughSequence >= topic.floor &&
			(throughSequence >= Number.MAX_SAFE_INTEGER ||
				state.eventTail >= Number.MAX_SAFE_INTEGER)
		)
			return rejected("capacity-exceeded");
		const before = state.messages.length;
		state.messages = state.messages.filter(
			(entry) => entry.topic !== topic.name || entry.sequence > throughSequence,
		);
		const removed = before - state.messages.length;
		if (removed > 0) {
			topic.floor = throughSequence + 1;
			topic.truncated = true;
			event(state, "compacted", topic.name);
		}
		return committed(state, {
			topic: topic.name,
			firstAvailableSequence: topic.floor,
			removedMessages: removed,
		});
	}
	return rejected("unsupported");
}

export function readRivetTopicLog(prior: string | undefined, input: unknown) {
	const state = stateFromJson(prior);
	if (
		!record(input) ||
		!keysOnly(input, ["topic", "afterSequence", "limit"]) ||
		!name(input.topic) ||
		!integer(input.afterSequence) ||
		!integer(input.limit, 1) ||
		input.limit > RIVET_DURABLE_TOPIC_LOG_LIMITS.batchSize
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

export function readRivetTopicAudit(prior: string | undefined, input: unknown) {
	const state = stateFromJson(prior);
	if (
		!record(input) ||
		!keysOnly(input, ["afterSequence", "limit"]) ||
		!integer(input.afterSequence) ||
		!integer(input.limit, 1) ||
		input.limit > RIVET_DURABLE_TOPIC_LOG_LIMITS.eventPageSize ||
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
