import { performance } from "node:perf_hooks";
import { types } from "node:util";
import {
	DURABLE_MESSAGING_LIMITS,
	type DurableMessaging,
	type DurableMessagingEvent,
	type DurableMessagingLimits,
	type DurableMessagingMessage,
	type DurableMessagingOperation,
	type DurableMessagingOutcome,
	type DurableMessagingRejectionCode,
	type DurableMessagingSubscription,
	parseDurableMessagingOperation,
} from "@hobo/core";

const MAX_REQUEST_BYTES = 131_072;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_RESPONSE_CHUNKS = 4_096;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const METHODS = [
	"ensure-topic",
	"ensure-subscription",
	"publish",
	"consume",
	"ack",
	"nack",
	"compact",
	"events",
	"read-log",
] as const;
type TopicMethod = (typeof METHODS)[number];

/** Capabilities independently attested for the bound actor, not inferred by this client. */
export interface RivetDurableTopicCapabilities {
	readonly topicCreation: boolean;
	readonly publish: boolean;
	readonly readRetainedLog: boolean;
	readonly compaction: boolean;
	readonly auditEvents: boolean;
	readonly consumerGroups: boolean;
	readonly leases: boolean;
	readonly acknowledgement: boolean;
	readonly deadLetter: boolean;
	readonly legacyWit: boolean;
}

/** A host-authenticated binding to one exclusive, durable Rivet actor. */
export interface RivetDurableTopicClientBinding {
	readonly actorName: string;
	readonly actorKey: readonly string[];
	readonly tenant: string;
	readonly instance: string;
	readonly semanticDigest: string;
	readonly limits: DurableMessagingLimits;
	readonly actorCapabilities: RivetDurableTopicCapabilities;
}

/** Facts to authenticate at the host and independently at the actor boundary. */
export interface RivetDurableTopicRequest {
	readonly actorName: string;
	readonly actorKey: readonly string[];
	readonly tenant: string;
	readonly instance: string;
	readonly semanticDigest: string;
	readonly limits: DurableMessagingLimits;
	readonly actorCapabilities: RivetDurableTopicCapabilities;
	readonly method: TopicMethod;
	readonly operation?: DurableMessagingOperation;
	readonly requestBase64: string;
}

/** A host-issued metadata capability, revoked permanently for this client generation. */
export interface RivetDurableTopicMetadataGrant {
	readonly revoke: () => void;
}
const metadataGrants = new WeakMap<object, { active: boolean }>();
export function createRivetDurableTopicMetadataGrant(): RivetDurableTopicMetadataGrant {
	const state = { active: true };
	const grant = Object.freeze({
		revoke: () => {
			state.active = false;
		},
	});
	metadataGrants.set(grant, state);
	return grant;
}

/** Host evidence for the exact transport and independently bounded ingress. */
export interface RivetDurableTopicTransportClaim {
	readonly phase: "dispatch" | "disclose";
	readonly binding: RivetDurableTopicClientBinding;
	readonly request: RivetDurableTopicRequest;
	readonly fetch: (path: string, init: RequestInit) => Promise<Response>;
	readonly maxRequestBytes: number;
	readonly maxResponseBytes: number;
	readonly maxChunkBytes: number;
	readonly maxResponseChunks: number;
	readonly responseBase64?: string;
}

/** A retained log row carries no lease or acknowledgement authority. */
export interface RivetDurableTopicLogMessage extends DurableMessagingMessage {
	readonly topic: string;
	readonly sequence: number;
}
export type RivetDurableTopicLogOutcome =
	| {
			readonly status: "ok";
			readonly messages: readonly RivetDurableTopicLogMessage[];
			readonly firstAvailableSequence: number;
			readonly nextAfterSequence: number;
			readonly hasMore: boolean;
	  }
	| {
			readonly status: "gap";
			readonly firstAvailableSequence: number;
			readonly latestSequence: number;
	  }
	| {
			readonly status: "rejected";
			readonly code: DurableMessagingRejectionCode;
	  };

/** Durable operations remain callable so the actor can durably reject unsupported ones. */
export interface RivetDurableTopicClient extends DurableMessaging {
	readonly actorCapabilities: RivetDurableTopicCapabilities;
	/** Read the retained log without acquiring a lease or acknowledging delivery. */
	readRetainedLog(input: {
		readonly topic: string;
		readonly afterSequence: number;
		readonly limit: number;
	}): Promise<RivetDurableTopicLogOutcome>;
}

export interface RivetDurableTopicClientOptions {
	readonly binding: RivetDurableTopicClientBinding;
	/** Independently attest actor routing, fencing and pre-allocation stream limits. */
	readonly verifyTransport: (
		claim: RivetDurableTopicTransportClaim,
	) => Promise<boolean> | boolean;
	readonly metadataGrant: RivetDurableTopicMetadataGrant;
	/** Issue credentials bound to the exact actor key, scope, method and request bytes. */
	readonly authorize: (
		request: RivetDurableTopicRequest,
	) =>
		| Promise<Readonly<Record<string, string>>>
		| Readonly<Record<string, string>>;
	/** Check the current principal, binding and authenticated raw response before disclosure. */
	readonly revalidate: (
		request: RivetDurableTopicRequest & { readonly responseBase64: string },
	) => Promise<boolean> | boolean;
	/** Trusted host adapter to the bound Rivet actor handle's fetch method. */
	readonly fetch: (path: string, init: RequestInit) => Promise<Response>;
	readonly timeoutMs?: number;
	readonly maxInFlight?: number;
}

// This boundary receives untrusted application and actor data.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: each input is validated and bounded before use or disclosure. */
function invalid(): never {
	throw new TypeError("rivet_topic.invalid_boundary_value");
}
function record(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		types.isProxy(value) ||
		Array.isArray(value)
	)
		return invalid();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return invalid();
	const keys = Reflect.ownKeys(value);
	if (
		keys.length > required.length + optional.length ||
		keys.some(
			(key) =>
				typeof key !== "string" ||
				(!required.includes(key) && !optional.includes(key)),
		)
	)
		return invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string") return invalid();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor === undefined ||
			!("value" in descriptor) ||
			!descriptor.enumerable
		)
			return invalid();
		result[key] = descriptor.value;
	}
	if (required.some((key) => !Object.hasOwn(result, key))) return invalid();
	return result;
}
function array(value: unknown, max: number): unknown[] {
	if (types.isProxy(value) || !Array.isArray(value)) return invalid();
	const len = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		!Number.isSafeInteger(len) ||
		len < 0 ||
		len > max ||
		Reflect.ownKeys(value).length !== len + 1
	)
		return invalid();
	const out: unknown[] = [];
	for (let i = 0; i < len; i++) {
		const property = Object.getOwnPropertyDescriptor(value, String(i));
		if (
			property === undefined ||
			!("value" in property) ||
			!property.enumerable
		)
			return invalid();
		out.push(property.value);
	}
	return out;
}
function text(
	value: unknown,
	max: number,
	empty = false,
	controls = false,
): string {
	if (
		typeof value !== "string" ||
		(!empty && value.length === 0) ||
		value.length > max ||
		/[\p{Cs}]/u.test(value) ||
		(!controls && /[\p{Cc}]/u.test(value)) ||
		Buffer.byteLength(value, "utf8") > max
	)
		return invalid();
	return value;
}
function integer(
	value: unknown,
	max = Number.MAX_SAFE_INTEGER,
	min = 0,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	)
		return invalid();
	return value;
}
function bytes(value: unknown, max: number): Uint8Array {
	if (types.isProxy(value) || !types.isUint8Array(value)) return invalid();
	const proto = Object.getPrototypeOf(Uint8Array.prototype);
	const size = Object.getOwnPropertyDescriptor(proto, "byteLength")?.get;
	const buffer = Object.getOwnPropertyDescriptor(proto, "buffer")?.get;
	if (size === undefined || buffer === undefined) return invalid();
	const n = size.call(value);
	const parent = buffer.call(value);
	if (
		!Number.isSafeInteger(n) ||
		n < 0 ||
		n > max ||
		types.isSharedArrayBuffer(parent) ||
		Reflect.ownKeys(value).length !== n
	)
		return invalid();
	const p = Object.getPrototypeOf(value);
	if (p !== Uint8Array.prototype && p !== Buffer.prototype) return invalid();
	const copy = new Uint8Array(n);
	Uint8Array.prototype.set.call(copy, value);
	return copy;
}
function operation(input: unknown): DurableMessagingOperation {
	const fields = record(input, ["id", "expiresAtMs"]);
	return parseDurableMessagingOperation({
		id: fields.id,
		expiresAtMs: fields.expiresAtMs,
	});
}
function requestOperation(value: unknown): DurableMessagingOperation {
	if (
		typeof value !== "object" ||
		value === null ||
		types.isProxy(value) ||
		Array.isArray(value)
	)
		return invalid();
	const field = Object.getOwnPropertyDescriptor(value, "operation");
	if (field === undefined || !("value" in field) || !field.enumerable)
		return invalid();
	return operation(field.value);
}
function limits(value: unknown): DurableMessagingLimits {
	const fields = record(value, Object.keys(DURABLE_MESSAGING_LIMITS));
	const cap: DurableMessagingLimits = Object.freeze({
		nameBytes: integer(fields.nameBytes, DURABLE_MESSAGING_LIMITS.nameBytes, 1),
		reasonBytes: integer(
			fields.reasonBytes,
			DURABLE_MESSAGING_LIMITS.reasonBytes,
			1,
		),
		payloadBytes: integer(
			fields.payloadBytes,
			DURABLE_MESSAGING_LIMITS.payloadBytes,
			1,
		),
		attributeCount: integer(
			fields.attributeCount,
			DURABLE_MESSAGING_LIMITS.attributeCount,
			1,
		),
		attributeBytes: integer(
			fields.attributeBytes,
			DURABLE_MESSAGING_LIMITS.attributeBytes,
			1,
		),
		batchSize: integer(fields.batchSize, DURABLE_MESSAGING_LIMITS.batchSize, 1),
		leaseMs: integer(fields.leaseMs, DURABLE_MESSAGING_LIMITS.leaseMs, 1),
		operationWindowMs: integer(
			fields.operationWindowMs,
			DURABLE_MESSAGING_LIMITS.operationWindowMs,
			1,
		),
		deliveryAttempts: integer(
			fields.deliveryAttempts,
			DURABLE_MESSAGING_LIMITS.deliveryAttempts,
			1,
		),
		retainedMessages: integer(
			fields.retainedMessages,
			DURABLE_MESSAGING_LIMITS.retainedMessages,
			1,
		),
		retainedReceipts: integer(
			fields.retainedReceipts,
			DURABLE_MESSAGING_LIMITS.retainedReceipts,
			1,
		),
		retainedEvents: integer(
			fields.retainedEvents,
			DURABLE_MESSAGING_LIMITS.retainedEvents,
			1,
		),
		topics: integer(fields.topics, DURABLE_MESSAGING_LIMITS.topics, 1),
		subscriptions: integer(
			fields.subscriptions,
			DURABLE_MESSAGING_LIMITS.subscriptions,
			1,
		),
		eventPageSize: integer(
			fields.eventPageSize,
			DURABLE_MESSAGING_LIMITS.eventPageSize,
			1,
		),
	});
	// JSON can escape each UTF-8 byte to six ASCII bytes; include envelope and array overhead.
	const payload = 4 * Math.ceil(cap.payloadBytes / 3);
	const request =
		payload +
		6 * cap.attributeBytes +
		6 * cap.reasonBytes +
		12 * cap.nameBytes +
		8192;
	const delivery =
		cap.batchSize *
			(payload +
				6 * cap.attributeBytes +
				6 * cap.reasonBytes +
				16 * cap.nameBytes +
				4096) +
		8192;
	const events = cap.eventPageSize * (6 * cap.nameBytes + 512) + 8192;
	if (
		request > MAX_REQUEST_BYTES ||
		delivery > MAX_RESPONSE_BYTES ||
		events > MAX_RESPONSE_BYTES
	)
		return invalid();
	return cap;
}
function subscription(
	value: unknown,
	cap: DurableMessagingLimits,
): DurableMessagingSubscription {
	const d = record(value, [
		"topic",
		"consumerGroup",
		"deadLetterTopic",
		"maxDeliveryAttempts",
		"startAt",
	]);
	const topic = text(d.topic, cap.nameBytes);
	const deadLetterTopic = text(d.deadLetterTopic, cap.nameBytes);
	if (
		topic === deadLetterTopic ||
		(d.startAt !== "earliest" && d.startAt !== "latest")
	)
		return invalid();
	return Object.freeze({
		topic,
		consumerGroup: text(d.consumerGroup, cap.nameBytes),
		deadLetterTopic,
		maxDeliveryAttempts: integer(
			d.maxDeliveryAttempts,
			cap.deliveryAttempts,
			1,
		),
		startAt: d.startAt,
	});
}
function message(value: unknown, cap: DurableMessagingLimits) {
	const d = record(value, ["id", "subject", "payload", "attributes"]);
	let total = 0;
	const seen = new Set<string>();
	const attributes = array(d.attributes, cap.attributeCount).map((entry) => {
		const item = record(entry, ["key", "value"]);
		const key = text(item.key, cap.attributeBytes, false, true);
		const val = text(item.value, cap.attributeBytes, true, true);
		total += Buffer.byteLength(key) + Buffer.byteLength(val);
		if (seen.has(key) || total > cap.attributeBytes) return invalid();
		seen.add(key);
		return { key, value: val };
	});
	return {
		id: text(d.id, cap.nameBytes),
		subject: text(d.subject, cap.nameBytes),
		payload: Buffer.from(bytes(d.payload, cap.payloadBytes)).toString("base64"),
		attributes,
	};
}
function decodedMessage(value: unknown, cap: DurableMessagingLimits) {
	const d = record(value, ["id", "subject", "payload", "attributes"]);
	const payload = text(
		d.payload,
		Math.ceil(cap.payloadBytes / 3) * 4,
		true,
		true,
	);
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
			payload,
		)
	)
		return invalid();
	const binary = Buffer.from(payload, "base64");
	if (binary.length > cap.payloadBytes || binary.toString("base64") !== payload)
		return invalid();
	const captured = message(
		{
			id: d.id,
			subject: d.subject,
			payload: new Uint8Array(binary),
			attributes: d.attributes,
		},
		cap,
	);
	return { ...captured, payload: new Uint8Array(binary) };
}
/** Deterministic JSON with bounded depth and node count; no value has custom serialization. */
function canonical(
	value: unknown,
	budget = { nodes: 100_000 },
	depth = 0,
): string {
	if (--budget.nodes < 0 || depth > 32) return invalid();
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return invalid();
		return JSON.stringify(value);
	}
	if (typeof value !== "object" || types.isProxy(value)) return invalid();
	if (Array.isArray(value))
		return `[${array(value, 100_000)
			.map((entry) => canonical(entry, budget, depth + 1))
			.join(",")}]`;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return invalid();
	const keys = Reflect.ownKeys(value);
	if (keys.length > 100_000 || keys.some((key) => typeof key !== "string"))
		return invalid();
	// SAFETY: the preceding check proves every own key is a string.
	const names = (keys as string[]).sort();
	return `{${names
		.map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				descriptor === undefined ||
				!("value" in descriptor) ||
				!descriptor.enumerable
			)
				return invalid();
			return `${JSON.stringify(key)}:${canonical(descriptor.value, budget, depth + 1)}`;
		})
		.join(",")}}`;
}
const rejectionCodes: readonly DurableMessagingRejectionCode[] = [
	"invalid-argument",
	"unauthorized",
	"not-found",
	"unsupported",
	"operation-conflict",
	"message-conflict",
	"subscription-conflict",
	"retention-blocked",
	"lease-lost",
	"capacity-exceeded",
	"unavailable",
];
function rejection(value: unknown): DurableMessagingRejectionCode {
	for (const code of rejectionCodes) if (value === code) return code;
	return invalid();
}
function outcome<T>(
	value: unknown,
	op: DurableMessagingOperation,
	committed: (value: unknown) => T,
): DurableMessagingOutcome<T> {
	const d = record(value, ["status"], ["value", "code", "operation"]);
	if (d.status === "committed") {
		const x = record(value, ["status", "value"]);
		return { status: "committed", value: committed(x.value) };
	}
	if (d.status === "rejected") {
		const x = record(value, ["status", "code"]);
		return { status: "rejected", code: rejection(x.code) };
	}
	if (d.status === "unknown" || d.status === "expired") {
		const x = record(value, ["status", "operation"]);
		const echoed = operation(x.operation);
		if (echoed.id !== op.id || echoed.expiresAtMs !== op.expiresAtMs)
			return invalid();
		return { status: d.status, operation: op };
	}
	return invalid();
}
function deliveries(
	value: unknown,
	topic: string,
	group: string,
	maximum: number,
	cap: DurableMessagingLimits,
) {
	const ids = new Set<string>();
	const sequences = new Set<number>();
	const leases = new Set<string>();
	return array(value, maximum).map((item) => {
		const d = record(
			item,
			[
				"message",
				"sequence",
				"topic",
				"consumerGroup",
				"leaseId",
				"leaseExpiresAtMs",
				"deliveryAttempt",
			],
			["deadLetter"],
		);
		const msg = decodedMessage(d.message, cap);
		const sequence = integer(d.sequence, Number.MAX_SAFE_INTEGER, 1);
		const leaseId = text(d.leaseId, cap.nameBytes);
		if (
			d.topic !== topic ||
			d.consumerGroup !== group ||
			ids.has(msg.id) ||
			sequences.has(sequence) ||
			leases.has(leaseId)
		)
			return invalid();
		ids.add(msg.id);
		sequences.add(sequence);
		leases.add(leaseId);
		let deadLetter:
			| {
					sourceTopic: string;
					consumerGroup: string;
					originalMessageId: string;
					originalSequence: number;
					deliveryAttempt: number;
					cause: { kind: "lease-expired" } | { kind: "nack"; reason: string };
			  }
			| undefined;
		if (d.deadLetter !== undefined) {
			const origin = record(d.deadLetter, [
				"sourceTopic",
				"consumerGroup",
				"originalMessageId",
				"originalSequence",
				"deliveryAttempt",
				"cause",
			]);
			const sourceTopic = text(origin.sourceTopic, cap.nameBytes);
			if (sourceTopic === topic) return invalid();
			const cause = record(origin.cause, ["kind"], ["reason"]);
			let parsedCause:
				| { kind: "lease-expired" }
				| { kind: "nack"; reason: string };
			if (cause.kind === "lease-expired") {
				record(origin.cause, ["kind"]);
				parsedCause = { kind: "lease-expired" };
			} else if (cause.kind === "nack") {
				const raw = record(origin.cause, ["kind", "reason"]);
				parsedCause = {
					kind: "nack",
					reason: text(raw.reason, cap.reasonBytes, true, true),
				};
			} else return invalid();
			deadLetter = {
				sourceTopic,
				consumerGroup: text(origin.consumerGroup, cap.nameBytes),
				originalMessageId: text(origin.originalMessageId, cap.nameBytes),
				originalSequence: integer(
					origin.originalSequence,
					Number.MAX_SAFE_INTEGER,
					1,
				),
				deliveryAttempt: integer(
					origin.deliveryAttempt,
					cap.deliveryAttempts,
					1,
				),
				cause: parsedCause,
			};
		}
		const delivery = {
			message: msg,
			sequence,
			topic,
			consumerGroup: group,
			leaseId,
			leaseExpiresAtMs: integer(d.leaseExpiresAtMs, Number.MAX_SAFE_INTEGER, 1),
			deliveryAttempt: integer(d.deliveryAttempt, cap.deliveryAttempts, 1),
		};
		if (deadLetter === undefined) return delivery;
		return { ...delivery, deadLetter };
	});
}
type MutableMessagingEvent = {
	-readonly [P in keyof DurableMessagingEvent]: DurableMessagingEvent[P];
};
function audit(
	value: unknown,
	after: number,
	maximum: number,
	cap: DurableMessagingLimits,
): Awaited<ReturnType<DurableMessaging["events"]>> {
	const base = record(
		value,
		["status"],
		[
			"events",
			"firstAvailableSequence",
			"nextAfterSequence",
			"hasMore",
			"latestSequence",
			"code",
		],
	);
	if (base.status === "rejected") {
		const d = record(value, ["status", "code"]);
		return { status: "rejected", code: rejection(d.code) };
	}
	if (base.status === "gap") {
		const d = record(value, [
			"status",
			"firstAvailableSequence",
			"latestSequence",
		]);
		const first = integer(d.firstAvailableSequence, Number.MAX_SAFE_INTEGER, 1);
		const latest = integer(d.latestSequence);
		if (after >= first - 1 || latest < first - 1) return invalid();
		return {
			status: "gap",
			firstAvailableSequence: first,
			latestSequence: latest,
		};
	}
	if (base.status !== "ok") return invalid();
	const d = record(value, [
		"status",
		"events",
		"firstAvailableSequence",
		"nextAfterSequence",
		"hasMore",
	]);
	const first = integer(d.firstAvailableSequence, Number.MAX_SAFE_INTEGER, 1);
	const next = integer(d.nextAfterSequence);
	if (typeof d.hasMore !== "boolean" || after < first - 1) return invalid();
	const kinds = [
		"topic-created",
		"subscription-created",
		"published",
		"leased",
		"acknowledged",
		"released",
		"dead-lettered",
		"compacted",
	] as const;
	const events = array(d.events, maximum).map((item, index) => {
		const event = record(
			item,
			["sequence", "kind", "topic"],
			["messageId", "consumerGroup"],
		);
		const sequence = integer(event.sequence, Number.MAX_SAFE_INTEGER, 1);
		const kind = kinds.find((candidate) => candidate === event.kind);
		if (kind === undefined || sequence !== after + index + 1) return invalid();
		const captured: MutableMessagingEvent = {
			sequence,
			kind,
			topic: text(event.topic, cap.nameBytes),
		};
		if (event.messageId !== undefined)
			captured.messageId = text(event.messageId, cap.nameBytes);
		if (event.consumerGroup !== undefined)
			captured.consumerGroup = text(event.consumerGroup, cap.nameBytes);
		return captured;
	});
	if (next !== after + events.length || (events.length === 0 && d.hasMore))
		return invalid();
	return {
		status: "ok",
		firstAvailableSequence: first,
		nextAfterSequence: next,
		hasMore: d.hasMore,
		events,
	};
}
function capabilities(value: unknown): RivetDurableTopicCapabilities {
	const keys = [
		"topicCreation",
		"publish",
		"readRetainedLog",
		"compaction",
		"auditEvents",
		"consumerGroups",
		"leases",
		"acknowledgement",
		"deadLetter",
		"legacyWit",
	] as const;
	const data = record(value, keys);
	const flag = (key: (typeof keys)[number]) => {
		if (typeof data[key] !== "boolean") return invalid();
		return data[key];
	};
	return Object.freeze({
		topicCreation: flag("topicCreation"),
		publish: flag("publish"),
		readRetainedLog: flag("readRetainedLog"),
		compaction: flag("compaction"),
		auditEvents: flag("auditEvents"),
		consumerGroups: flag("consumerGroups"),
		leases: flag("leases"),
		acknowledgement: flag("acknowledgement"),
		deadLetter: flag("deadLetter"),
		legacyWit: flag("legacyWit"),
	});
}
function retainedLog(
	value: unknown,
	topic: string,
	after: number,
	maximum: number,
	cap: DurableMessagingLimits,
): RivetDurableTopicLogOutcome {
	const base = record(
		value,
		["status"],
		[
			"messages",
			"firstAvailableSequence",
			"nextAfterSequence",
			"hasMore",
			"latestSequence",
			"code",
		],
	);
	if (base.status === "rejected") {
		const d = record(value, ["status", "code"]);
		return { status: "rejected", code: rejection(d.code) };
	}
	if (base.status === "gap") {
		const d = record(value, [
			"status",
			"firstAvailableSequence",
			"latestSequence",
		]);
		const first = integer(d.firstAvailableSequence, Number.MAX_SAFE_INTEGER, 1);
		const latest = integer(d.latestSequence);
		if (after >= first - 1 || latest < first - 1) return invalid();
		return {
			status: "gap",
			firstAvailableSequence: first,
			latestSequence: latest,
		};
	}
	if (base.status !== "ok") return invalid();
	const d = record(value, [
		"status",
		"messages",
		"firstAvailableSequence",
		"nextAfterSequence",
		"hasMore",
	]);
	const first = integer(d.firstAvailableSequence, Number.MAX_SAFE_INTEGER, 1);
	const next = integer(d.nextAfterSequence);
	if (typeof d.hasMore !== "boolean" || after < first - 1) return invalid();
	const ids = new Set<string>();
	const messages = array(d.messages, maximum).map((item, index) => {
		const row = record(item, [
			"topic",
			"sequence",
			"id",
			"subject",
			"payload",
			"attributes",
		]);
		const sequence = integer(row.sequence, Number.MAX_SAFE_INTEGER, 1);
		if (row.topic !== topic || sequence !== after + index + 1) return invalid();
		const message = decodedMessage(
			{
				id: row.id,
				subject: row.subject,
				payload: row.payload,
				attributes: row.attributes,
			},
			cap,
		);
		if (ids.has(message.id)) return invalid();
		ids.add(message.id);
		return { ...message, topic, sequence };
	});
	if (next !== after + messages.length || (messages.length === 0 && d.hasMore))
		return invalid();
	return {
		status: "ok",
		messages,
		firstAvailableSequence: first,
		nextAfterSequence: next,
		hasMore: d.hasMore,
	};
}

function binding(value: unknown): RivetDurableTopicClientBinding {
	const d = record(value, [
		"actorName",
		"actorKey",
		"tenant",
		"instance",
		"semanticDigest",
		"limits",
		"actorCapabilities",
	]);
	const actorKey = array(d.actorKey, 16).map((key) => text(key, 128));
	if (actorKey.length === 0) return invalid();
	const semanticDigest = text(d.semanticDigest, 71);
	if (!/^sha256:[a-f0-9]{64}$/u.test(semanticDigest)) return invalid();
	return Object.freeze({
		actorName: text(d.actorName, 128),
		actorKey: Object.freeze(actorKey),
		tenant: text(d.tenant, 128),
		instance: text(d.instance, 128),
		semanticDigest,
		limits: limits(d.limits),
		actorCapabilities: capabilities(d.actorCapabilities),
	});
}
function headers(value: unknown): Headers {
	if (
		typeof value !== "object" ||
		value === null ||
		types.isProxy(value) ||
		Array.isArray(value)
	)
		return invalid();
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return invalid();
	const keys = Reflect.ownKeys(value);
	if (keys.length > 32) return invalid();
	const output = new Headers({ "content-type": "application/json" });
	let length = 0;
	for (const key of keys) {
		if (
			typeof key !== "string" ||
			!/^[a-z0-9-]{1,100}$/u.test(key) ||
			[
				"host",
				"content-length",
				"content-type",
				"connection",
				"transfer-encoding",
			].includes(key)
		)
			return invalid();
		const field = Object.getOwnPropertyDescriptor(value, key);
		if (field === undefined || !("value" in field) || !field.enumerable)
			return invalid();
		const val = text(field.value, 4096, false);
		length += key.length + val.length;
		if (length > 8192) return invalid();
		output.set(key, val);
	}
	return output;
}
async function cancelResponse(response: Response): Promise<void> {
	try {
		if (
			typeof response !== "object" ||
			response === null ||
			types.isProxy(response) ||
			!(response instanceof Response)
		)
			return;
		const getter = Object.getOwnPropertyDescriptor(
			Response.prototype,
			"body",
		)?.get;
		if (getter === undefined) return;
		const stream: ReadableStream<Uint8Array> | null = getter.call(response);
		if (stream !== null) await stream.cancel();
	} catch {
		/* the host must separately fence a transport that cannot be cancelled */
	}
}
async function responseBytes(
	response: Response,
	alive: () => boolean,
	signal: AbortSignal,
): Promise<Uint8Array> {
	if (
		typeof response !== "object" ||
		response === null ||
		types.isProxy(response) ||
		!(response instanceof Response)
	)
		return invalid();
	const status = Object.getOwnPropertyDescriptor(
		Response.prototype,
		"status",
	)?.get;
	const body = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get;
	if (status === undefined || body === undefined) return invalid();
	const stream: ReadableStream<Uint8Array> | null = body.call(response);
	if (stream === null) return invalid();
	const reader = stream.getReader();
	let cancellation: Promise<void> | undefined;
	const cancel = (): Promise<void> => {
		if (cancellation === undefined) {
			try {
				cancellation = reader.cancel().catch(() => {});
			} catch {
				cancellation = Promise.resolve();
			}
		}
		return cancellation;
	};
	const abort = () => {
		void cancel();
	};
	signal.addEventListener("abort", abort, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	let complete = false;
	try {
		if (status.call(response) !== 200) return invalid();
		for (let count = 0; count <= MAX_RESPONSE_CHUNKS; count++) {
			if (!alive()) return invalid();
			const next = await reader.read();
			if (!alive()) return invalid();
			if (next.done) {
				complete = true;
				break;
			}
			if (count === MAX_RESPONSE_CHUNKS) return invalid();
			const chunk = bytes(next.value, MAX_RESPONSE_BYTES);
			size += chunk.length;
			if (size > MAX_RESPONSE_BYTES) return invalid();
			chunks.push(chunk);
		}
		if (!complete) return invalid();
	} finally {
		signal.removeEventListener("abort", abort);
		if (!complete || cancellation !== undefined) await cancel();
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/**
 * Build a client for one host-attested Rivet HTTP actor binding. The host must
 * authenticate the exact actor key, principal, semantic digest and raw bytes on
 * both sides, enforce exclusive journal ownership, and fence every in-flight
 * call through disclosure. An arbitrary fetch callback is not that authority.
 */
export function createRivetDurableTopicClient(
	options: RivetDurableTopicClientOptions,
): RivetDurableTopicClient {
	const settings = record(
		options,
		[
			"binding",
			"metadataGrant",
			"verifyTransport",
			"authorize",
			"revalidate",
			"fetch",
		],
		["timeoutMs", "maxInFlight"],
	);
	if (
		typeof settings.verifyTransport !== "function" ||
		types.isProxy(settings.verifyTransport) ||
		typeof settings.authorize !== "function" ||
		types.isProxy(settings.authorize) ||
		typeof settings.revalidate !== "function" ||
		types.isProxy(settings.revalidate) ||
		typeof settings.fetch !== "function" ||
		types.isProxy(settings.fetch)
	)
		return invalid();
	const scope = binding(settings.binding);
	if (
		typeof settings.metadataGrant !== "object" ||
		settings.metadataGrant === null ||
		types.isProxy(settings.metadataGrant)
	)
		return invalid();
	const metadata = metadataGrants.get(settings.metadataGrant);
	if (metadata === undefined) return invalid();
	const timeoutMs =
		settings.timeoutMs === undefined
			? 30_000
			: integer(settings.timeoutMs, 300_000, 1);
	const maxInFlight =
		settings.maxInFlight === undefined
			? 128
			: integer(settings.maxInFlight, 128, 1);
	// SAFETY: the own data callback was checked and is supplied by the trusted host.
	const verifyTransport =
		settings.verifyTransport as RivetDurableTopicClientOptions["verifyTransport"];
	// SAFETY: the own data callback was checked and is supplied by the trusted host.
	const authorize =
		settings.authorize as RivetDurableTopicClientOptions["authorize"];
	// SAFETY: the callback is checked above and is supplied by the trusted host.
	const revalidate =
		settings.revalidate as RivetDurableTopicClientOptions["revalidate"];
	// SAFETY: the callback is checked above and is supplied by the trusted host.
	const fetch = settings.fetch as RivetDurableTopicClientOptions["fetch"];
	let active = 0;
	const bounded = async <T>(
		run: (alive: () => boolean, signal: AbortSignal) => Promise<T>,
	): Promise<T> => {
		if (active >= maxInFlight) throw new Error("rivet_topic.capacity");
		active++;
		const controller = new AbortController();
		const deadline = performance.now() + timeoutMs;
		let expired = false;
		const alive = () => !expired && performance.now() < deadline;
		const work = Promise.resolve()
			.then(() => {
				if (!alive()) throw new Error("rivet_topic.timeout");
				return run(alive, controller.signal);
			})
			.finally(() => {
				active--;
			});
		const inTime = work.then((value) => {
			if (!alive()) throw new Error("rivet_topic.timeout");
			return value;
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				expired = true;
				controller.abort();
				reject(new Error("rivet_topic.timeout"));
			}, timeoutMs);
		});
		try {
			return await Promise.race([inTime, timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
	const request = async (
		method: TopicMethod,
		payload: Readonly<Record<string, unknown>>,
		op?: DurableMessagingOperation,
	): Promise<unknown> => {
		const encoded = canonical(payload);
		if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) return invalid();
		const raw = encoder.encode(encoded);
		const facts = {
			actorName: scope.actorName,
			actorKey: scope.actorKey,
			tenant: scope.tenant,
			instance: scope.instance,
			semanticDigest: scope.semanticDigest,
			limits: scope.limits,
			actorCapabilities: scope.actorCapabilities,
			method,
			requestBase64: Buffer.from(raw).toString("base64"),
		};
		const observation: RivetDurableTopicRequest = Object.freeze(
			op === undefined ? facts : { ...facts, operation: op },
		);
		return bounded(async (alive, signal) => {
			const transport = Object.freeze({
				binding: scope,
				request: observation,
				fetch,
				maxRequestBytes: MAX_REQUEST_BYTES,
				maxResponseBytes: MAX_RESPONSE_BYTES,
				maxChunkBytes: MAX_RESPONSE_BYTES,
				maxResponseChunks: MAX_RESPONSE_CHUNKS,
			});
			if (
				(await verifyTransport(
					Object.freeze({ ...transport, phase: "dispatch" as const }),
				)) !== true ||
				!alive()
			)
				throw new Error("rivet_topic.transport_unverified");
			const credentials = headers(await authorize(observation));
			if (
				!alive() ||
				((method === "events" || method === "read-log") && !metadata.active)
			)
				throw new Error("rivet_topic.timeout");
			const response = await fetch(`/${method}`, {
				method: "POST",
				headers: credentials,
				body: encoded,
				redirect: "error",
				signal,
			});
			if (!alive()) {
				await cancelResponse(response);
				throw new Error("rivet_topic.timeout");
			}
			const content = await responseBytes(response, alive, signal);
			if (!alive()) throw new Error("rivet_topic.timeout");
			const disclosure = Object.freeze({
				...observation,
				responseBase64: Buffer.from(content).toString("base64"),
			});
			if (
				(await verifyTransport(
					Object.freeze({
						...transport,
						phase: "disclose" as const,
						responseBase64: disclosure.responseBase64,
					}),
				)) !== true ||
				!alive()
			)
				throw new Error("rivet_topic.transport_unverified");
			if (
				(await revalidate(disclosure)) !== true ||
				!alive() ||
				((method === "events" || method === "read-log") && !metadata.active)
			)
				throw new Error("rivet_topic.unauthorized");
			const textValue = decoder.decode(content);
			const parsed: unknown = JSON.parse(textValue);
			if (canonical(parsed) !== textValue) return invalid();
			return parsed;
		});
	};
	const supportsMutation = (method: TopicMethod): boolean => {
		const cap = scope.actorCapabilities;
		switch (method) {
			case "ensure-topic":
				return cap.topicCreation;
			case "ensure-subscription":
				return cap.consumerGroups && cap.deadLetter;
			case "publish":
				return cap.publish;
			case "consume":
				return cap.consumerGroups && cap.leases && cap.deadLetter;
			case "ack":
				return (
					cap.consumerGroups &&
					cap.leases &&
					cap.acknowledgement &&
					cap.deadLetter
				);
			case "nack":
				return cap.consumerGroups && cap.leases && cap.deadLetter;
			case "compact":
				return cap.compaction;
			default:
				return false;
		}
	};
	const mutation = async <T>(
		input: unknown,
		method: TopicMethod,
		capture: (
			op: DurableMessagingOperation,
		) => Readonly<Record<string, unknown>>,
		receive: (value: unknown) => T,
	): Promise<DurableMessagingOutcome<T>> => {
		const op = requestOperation(input);
		try {
			const captured = capture(op);
			const result = outcome(await request(method, captured, op), op, receive);
			if (result.status === "committed" && !supportsMutation(method))
				return invalid();
			return result;
		} catch {
			return { status: "unknown", operation: op };
		}
	};
	const client: RivetDurableTopicClient = {
		get actorCapabilities() {
			if (!metadata.active) throw new Error("rivet_topic.metadata_revoked");
			return scope.actorCapabilities;
		},
		get limits() {
			if (!metadata.active) throw new Error("rivet_topic.metadata_revoked");
			return scope.limits;
		},
		ensureTopic: (input) => {
			let topic: string;
			return mutation(
				input,
				"ensure-topic",
				(op) => {
					const d = record(input, ["operation", "topic"]);
					topic = text(d.topic, scope.limits.nameBytes);
					return { operation: op, topic };
				},
				(value) => {
					const d = record(value, ["topic"]);
					if (d.topic !== topic) return invalid();
					return { topic };
				},
			);
		},
		ensureSubscription: (input) => {
			let expected: DurableMessagingSubscription;
			return mutation(
				input,
				"ensure-subscription",
				(op) => {
					const d = record(input, ["operation", "subscription"]);
					expected = subscription(d.subscription, scope.limits);
					return { operation: op, subscription: expected };
				},
				(value) => {
					const d = record(value, [
						"subscription",
						"firstAvailableSequence",
						"historyTruncated",
					]);
					const actual = subscription(d.subscription, scope.limits);
					if (canonical(actual) !== canonical(expected)) return invalid();
					const first = integer(
						d.firstAvailableSequence,
						Number.MAX_SAFE_INTEGER,
						1,
					);
					if (
						typeof d.historyTruncated !== "boolean" ||
						d.historyTruncated !== first > 1
					)
						return invalid();
					return {
						subscription: actual,
						firstAvailableSequence: first,
						historyTruncated: d.historyTruncated,
					};
				},
			);
		},
		publish: (input) => {
			let expected: string;
			return mutation(
				input,
				"publish",
				(op) => {
					const d = record(input, ["operation", "topic", "message"]);
					const msg = message(d.message, scope.limits);
					expected = msg.id;
					return {
						operation: op,
						topic: text(d.topic, scope.limits.nameBytes),
						message: msg,
					};
				},
				(value) => {
					const d = record(value, ["messageId", "sequence"]);
					if (d.messageId !== expected) return invalid();
					return {
						messageId: expected,
						sequence: integer(d.sequence, Number.MAX_SAFE_INTEGER, 1),
					};
				},
			);
		},
		consume: (input) => {
			let topic: string;
			let group: string;
			let count: number;
			return mutation(
				input,
				"consume",
				(op) => {
					const d = record(input, [
						"operation",
						"topic",
						"consumerGroup",
						"maxMessages",
						"visibilityTimeoutMs",
					]);
					topic = text(d.topic, scope.limits.nameBytes);
					group = text(d.consumerGroup, scope.limits.nameBytes);
					count = integer(d.maxMessages, scope.limits.batchSize, 1);
					return {
						operation: op,
						topic,
						consumerGroup: group,
						maxMessages: count,
						visibilityTimeoutMs: integer(
							d.visibilityTimeoutMs,
							scope.limits.leaseMs,
							1,
						),
					};
				},
				(value) => {
					const result = deliveries(value, topic, group, count, scope.limits);
					if (
						!scope.actorCapabilities.deadLetter &&
						result.some(
							(delivery) =>
								"deadLetter" in delivery && delivery.deadLetter !== undefined,
						)
					)
						return invalid();
					return result;
				},
			);
		},
		ack: (input) => {
			let messageId: string;
			let sequence: number;
			return mutation(
				input,
				"ack",
				(op) => {
					const d = record(input, [
						"operation",
						"topic",
						"consumerGroup",
						"messageId",
						"sequence",
						"leaseId",
					]);
					messageId = text(d.messageId, scope.limits.nameBytes);
					sequence = integer(d.sequence, Number.MAX_SAFE_INTEGER, 1);
					return {
						operation: op,
						topic: text(d.topic, scope.limits.nameBytes),
						consumerGroup: text(d.consumerGroup, scope.limits.nameBytes),
						messageId,
						sequence,
						leaseId: text(d.leaseId, scope.limits.nameBytes),
					};
				},
				(value) => {
					const d = record(value, ["messageId", "sequence"]);
					if (d.messageId !== messageId || d.sequence !== sequence)
						return invalid();
					return { messageId, sequence };
				},
			);
		},
		nack: (input) => {
			let messageId: string;
			let sequence: number;
			return mutation(
				input,
				"nack",
				(op) => {
					const d = record(input, [
						"operation",
						"topic",
						"consumerGroup",
						"messageId",
						"sequence",
						"leaseId",
						"reason",
					]);
					messageId = text(d.messageId, scope.limits.nameBytes);
					sequence = integer(d.sequence, Number.MAX_SAFE_INTEGER, 1);
					return {
						operation: op,
						topic: text(d.topic, scope.limits.nameBytes),
						consumerGroup: text(d.consumerGroup, scope.limits.nameBytes),
						messageId,
						sequence,
						leaseId: text(d.leaseId, scope.limits.nameBytes),
						reason: text(d.reason, scope.limits.reasonBytes, true, true),
					};
				},
				(value) => {
					const d = record(
						value,
						["messageId", "sequence", "disposition"],
						["deadLetterMessageId", "deadLetterSequence"],
					);
					if (d.messageId !== messageId || d.sequence !== sequence)
						return invalid();
					if (d.disposition === "released") {
						record(value, ["messageId", "sequence", "disposition"]);
						return { messageId, sequence, disposition: "released" as const };
					}
					if (
						d.disposition !== "dead-lettered" ||
						!scope.actorCapabilities.deadLetter
					)
						return invalid();
					const settled = record(value, [
						"messageId",
						"sequence",
						"disposition",
						"deadLetterMessageId",
						"deadLetterSequence",
					]);
					return {
						messageId,
						sequence,
						disposition: "dead-lettered" as const,
						deadLetterMessageId: text(
							settled.deadLetterMessageId,
							scope.limits.nameBytes,
						),
						deadLetterSequence: integer(
							settled.deadLetterSequence,
							Number.MAX_SAFE_INTEGER,
							1,
						),
					};
				},
			);
		},
		compact: (input) => {
			let topic: string;
			let throughSequence: number;
			return mutation(
				input,
				"compact",
				(op) => {
					const d = record(input, ["operation", "topic", "throughSequence"]);
					topic = text(d.topic, scope.limits.nameBytes);
					throughSequence = integer(d.throughSequence);
					return { operation: op, topic, throughSequence };
				},
				(value) => {
					const d = record(value, [
						"topic",
						"firstAvailableSequence",
						"removedMessages",
					]);
					const first = integer(
						d.firstAvailableSequence,
						Number.MAX_SAFE_INTEGER,
						1,
					);
					const removed = integer(
						d.removedMessages,
						scope.limits.retainedMessages,
					);
					if (d.topic !== topic || (removed > 0 && first - 1 > throughSequence))
						return invalid();
					return {
						topic,
						firstAvailableSequence: first,
						removedMessages: removed,
					};
				},
			);
		},
		readRetainedLog: async (input) => {
			let topic: string;
			let afterSequence: number;
			let limit: number;
			try {
				const d = record(input, ["topic", "afterSequence", "limit"]);
				topic = text(d.topic, DURABLE_MESSAGING_LIMITS.nameBytes);
				afterSequence = integer(d.afterSequence);
				limit = integer(d.limit, DURABLE_MESSAGING_LIMITS.batchSize, 1);
			} catch {
				return { status: "rejected", code: "invalid-argument" };
			}
			try {
				if (!metadata.active) throw new Error("rivet_topic.metadata_revoked");
				const raw = await request("read-log", { topic, afterSequence, limit });
				if (!metadata.active) throw new Error("rivet_topic.metadata_revoked");
				const result = retainedLog(
					raw,
					topic,
					afterSequence,
					Math.min(limit, scope.limits.batchSize),
					scope.limits,
				);
				if (
					result.status !== "rejected" &&
					!scope.actorCapabilities.readRetainedLog
				)
					return invalid();
				if (
					(limit > scope.limits.batchSize ||
						Buffer.byteLength(topic, "utf8") > scope.limits.nameBytes) &&
					(result.status !== "rejected" || result.code !== "invalid-argument")
				)
					return invalid();
				return result;
			} catch {
				return { status: "rejected", code: "unavailable" };
			}
		},
		events: async (input) => {
			let afterSequence: number;
			let limit: number;
			try {
				const d = record(input, ["afterSequence", "limit"]);
				afterSequence = integer(d.afterSequence);
				limit = integer(d.limit, DURABLE_MESSAGING_LIMITS.eventPageSize, 1);
			} catch {
				return { status: "rejected", code: "invalid-argument" };
			}
			try {
				if (!metadata.active) throw new Error("rivet_topic.metadata_revoked");
				const raw = await request("events", { afterSequence, limit });
				if (!metadata.active) throw new Error("rivet_topic.metadata_revoked");
				const result = audit(
					raw,
					afterSequence,
					Math.min(limit, scope.limits.eventPageSize),
					scope.limits,
				);
				if (
					result.status !== "rejected" &&
					!scope.actorCapabilities.auditEvents
				)
					return invalid();
				if (
					limit > scope.limits.eventPageSize &&
					(result.status !== "rejected" || result.code !== "invalid-argument")
				)
					return invalid();
				return result;
			} catch {
				return { status: "rejected", code: "unavailable" };
			}
		},
	};
	return Object.freeze(client);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
