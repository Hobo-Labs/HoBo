import {
	type ClockTraceEntry,
	NondeterministicClockError,
	parseIsoInstant,
	QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
	QueueLeaseLostError,
} from "@hobo/core";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

export interface QueueMessageRecord {
	messageId: string;
	queueName: string;
	idempotencyKey: string;
	body: JsonValue;
	state: "pending" | "leased" | "completed";
	availableAtMs: number;
	deliveryAttempt: number;
	leaseId: string | null;
	leaseExpiresAtMs: number | null;
	completedAtMs: number | null;
	processing: boolean;
}

export interface SleepTimerRecord {
	timerId: string;
	kind: "sleep";
	runId: string;
	label?: string;
	idempotencyKey: string;
	scheduledAtMs: number;
	fireAtMs: number;
	firedAtMs: number | null;
	firedOrder: number | null;
}

export interface CronScheduleRecord {
	scheduleId: string;
	everyMs: number;
	startAtMs: number;
	nextFireAtMs: number;
	occurrence: number;
}

export interface QueueClockStore {
	version: string;
	seed: string;
	nowMs: number;
	nextMessageSeq: number;
	nextLeaseSeq: number;
	nextTimerSeq: number;
	nextFireSeq: number;
	queues: Record<string, { name: string; messages: QueueMessageRecord[] }>;
	timers: SleepTimerRecord[];
	cronSchedules: CronScheduleRecord[];
	trace: ClockTraceEntry[];
}

export interface QueueClockSnapshot {
	version: string;
	seed: string;
	nowMs: number;
	nextMessageSeq: number;
	nextLeaseSeq: number;
	nextTimerSeq: number;
	nextFireSeq: number;
	queues: Record<string, { name: string; messages: QueueMessageRecord[] }>;
	timers: SleepTimerRecord[];
	cronSchedules: CronScheduleRecord[];
	trace: ClockTraceEntry[];
}

export interface RuntimeLocalQueueClockOptions {
	seed?: string;
	startInstant?: string;
	snapshot?: QueueClockSnapshot;
}

export function formatInstant(timestampMs: number): string {
	return new Date(timestampMs).toISOString();
}

export function parseInstantMs(value: string, fieldName: string): number {
	const ms = Date.parse(value);
	if (!isJsonString(value) || Number.isNaN(ms)) {
		throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
	}
	return ms;
}

export function requireNonEmptyString(
	value: JsonValue,
	fieldName: string,
): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${fieldName} must be a non-empty string`);
	}
	return value;
}

export function normalizePositiveInteger(
	value: JsonValue,
	fieldName: string,
): number {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${fieldName} must be a positive safe integer`);
	}
	return value;
}

export function normalizeNonNegativeInteger(
	value: JsonValue,
	fieldName: string,
): number {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${fieldName} must be a non-negative safe integer`);
	}
	return value;
}

export function cloneStore<T>(value: T): T {
	if (value === undefined) {
		return value;
	}
	if (structuredClone instanceof Function) {
		return structuredClone(value);
	}
	const cloned = parseJsonValue(JSON.stringify(value));
	// SAFETY: JSON round-trip preserves the caller-owned store snapshot type.
	return cloned as T;
}

function deepFreeze<T>(value: T): T {
	// Arrays as well as plain objects: `store.trace` and every queue's
	// `messages` are arrays, so a guard that admitted only plain objects would
	// hand back a "frozen" snapshot whose queues could still be pushed to.
	if (Array.isArray(value) || isJsonObject(value)) {
		Object.freeze(value);
		for (const nested of Object.values(value)) {
			deepFreeze(nested);
		}
	}
	return value;
}

export function appendTrace(
	store: QueueClockStore,
	event: ClockTraceEntry,
): void {
	// SAFETY: assertion to `deepFreeze({ ...event }) as ClockTraceEntry` is required at this boundary.
	store.trace.push(deepFreeze({ ...event }) as ClockTraceEntry);
}

export function normalizeStore(
	options: RuntimeLocalQueueClockOptions = {},
): QueueClockStore {
	if (options.snapshot) {
		const snapshot = cloneStore(options.snapshot);
		if (options.seed !== undefined && options.seed !== snapshot.seed) {
			throw new NondeterministicClockError(
				`snapshot seed mismatch: expected ${snapshot.seed}, got ${options.seed}`,
			);
		}
		return {
			version: QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
			seed: requireNonEmptyString(snapshot.seed, "snapshot.seed"),
			nowMs: normalizeNonNegativeInteger(snapshot.nowMs, "snapshot.nowMs"),
			nextMessageSeq: normalizePositiveInteger(
				snapshot.nextMessageSeq,
				"snapshot.nextMessageSeq",
			),
			nextLeaseSeq: normalizePositiveInteger(
				snapshot.nextLeaseSeq,
				"snapshot.nextLeaseSeq",
			),
			nextTimerSeq: normalizePositiveInteger(
				snapshot.nextTimerSeq,
				"snapshot.nextTimerSeq",
			),
			nextFireSeq: normalizePositiveInteger(
				snapshot.nextFireSeq,
				"snapshot.nextFireSeq",
			),
			queues: snapshot.queues ?? {},
			timers: snapshot.timers ?? [],
			cronSchedules: snapshot.cronSchedules ?? [],
			trace: snapshot.trace ?? [],
		};
	}

	const seed = requireNonEmptyString(
		options.seed ?? "runtime-local-seed",
		"options.seed",
	);
	const nowMs = parseInstantMs(
		options.startInstant ?? "2026-06-26T00:00:00.000Z",
		"options.startInstant",
	);
	const store: QueueClockStore = {
		version: QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
		seed,
		nowMs,
		nextMessageSeq: 1,
		nextLeaseSeq: 1,
		nextTimerSeq: 1,
		nextFireSeq: 1,
		queues: {},
		timers: [],
		cronSchedules: [],
		trace: [],
	};
	appendTrace(store, {
		type: "clock.started",
		seed,
		atMs: nowMs,
		at: parseIsoInstant(formatInstant(nowMs)),
	});
	return store;
}

export function snapshotStore(store: QueueClockStore): QueueClockSnapshot {
	return deepFreeze(cloneStore(store));
}

export function getQueue(store: QueueClockStore, queueName: string) {
	const name = requireNonEmptyString(queueName, "queueName");
	store.queues[name] ??= { name, messages: [] };
	return store.queues[name];
}

export function findMessageById(
	store: QueueClockStore,
	messageId: string,
): QueueMessageRecord {
	const id = requireNonEmptyString(messageId, "messageId");
	for (const queue of Object.values(store.queues)) {
		const message = queue.messages.find(
			(candidate) => candidate.messageId === id,
		);
		if (message) {
			return message;
		}
	}
	throw new QueueLeaseLostError(`unknown message ${id}`);
}

export function isAvailableForLease(
	message: QueueMessageRecord,
	nowMs: number,
): boolean {
	if (message.processing) {
		return false;
	}
	if (message.completedAtMs !== null && message.state === "completed") {
		return false;
	}
	if (message.availableAtMs > nowMs) {
		return false;
	}
	return (
		message.state === "pending" ||
		(message.state === "leased" &&
			message.leaseExpiresAtMs !== null &&
			message.leaseExpiresAtMs <= nowMs)
	);
}
