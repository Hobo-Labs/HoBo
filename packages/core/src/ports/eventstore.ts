import type { EventEnvelope, PrincipalRef } from "../envelope.js";
import { CoreParseError } from "../errors.js";
import {
	isJsonArray,
	isJsonBigInt,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

export interface Clock {
	now(): string;
}

export interface EventInput<T = unknown> {
	type: string;
	v?: number;
	data?: T;
	meta?: JsonObject;
}

/**
 * Database-local monotonic position within one storage partition.
 * Distinct from domain EventEnvelope.seq (per-stream) and event id (ULID).
 * Represented as bigint so full 64-bit values survive Node + browser WASM.
 */
export type EventPosition = bigint & { readonly __brand: "EventPosition" };

/**
 * Actor fencing token / owner epoch. Monotonic per stream key.
 * Full 64-bit; never coerce to Number.
 */
export type FenceToken = bigint & { readonly __brand: "FenceToken" };

export interface PositionedEvent {
	readonly position: EventPosition;
	readonly event: EventEnvelope;
}

export interface AppendOptions {
	expectedSeq: number;
	actor: PrincipalRef;
	tenant: string;
	project?: string;
	causationId?: string;
	correlationId?: string;
	lane?: string;
	/** When set, rejects appends if stored owner_epoch is higher (stale holder). */
	fenceToken?: bigint;
}

export interface AppendResult {
	streamId: string;
	appended: EventEnvelope[];
	deduped: EventEnvelope[];
	/** First database-local position of this commit, if any events appended. */
	firstPosition?: EventPosition;
	/** Last database-local position of this commit, if any events appended. */
	lastPosition?: EventPosition;
}

export interface StreamFilter {
	streamId?: string;
	type?: string;
}

export interface ReadAllOptions {
	readonly after?: EventPosition;
	readonly limit?: number;
	readonly filter?: StreamFilter;
	readonly tenant?: string;
	readonly lane?: string;
}

export interface Subscription {
	unsubscribe(): void;
}

export interface SnapshotRecord<S = unknown> {
	streamId: string;
	seq: number;
	state: S;
	savedAt: string;
}

/**
 * Stream head metadata for fenced streams. Stores that enforce single-writer
 * fencing (owner_epoch) expose it so choreography writers on the same
 * partition can continue a fenced stream instead of bypassing the fence.
 */
export interface StreamHead {
	readonly streamId: string;
	/** Current revision (== seq of the last appended event). */
	readonly revision: number;
	/** Current fencing owner epoch; 0 = unfenced. */
	readonly ownerEpoch: bigint;
}

export type FoldHandlers<S> = Record<
	string,
	(state: S, event: EventEnvelope) => S
>;

export interface FoldResult<S> {
	streamId: string;
	seq: number;
	state: S;
	quarantined: QuarantineRecord[];
}

export interface QuarantineRecord {
	offendingSeq: number;
	quarantineSeq: number;
	type: string;
	reason: string;
}

/** Writer authority for stores that protect snapshots with an actor lease.
 * Such stores must check the exact live fence at commit, including expiry. */
export interface SnapshotWriteOptions {
	readonly fenceToken?: bigint;
}

/** Baseline EventStore port — append, stream read, live wake, snapshot. */
export interface EventStore {
	append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult>;
	read(streamId: string, fromSeq?: number): AsyncIterable<EventEnvelope>;
	subscribe(
		filter: StreamFilter,
		handler: (event: EventEnvelope) => void | Promise<void>,
	): Subscription;
	snapshot(
		streamId: string,
		state: JsonValue,
		seq: number,
		opts?: SnapshotWriteOptions,
	): Promise<SnapshotRecord>;
	/** Present on stores that enforce single-writer fencing. */
	getStreamHead?(streamId: string): StreamHead | undefined;
}

// ── Durable effects (staged with domain events in one transaction) ──────────

export type DurableEffectKind =
	| "queue"
	| "actor-signal"
	| "timer"
	| "cron"
	| "outbox";

export interface QueueEffectInput {
	readonly kind: "queue";
	readonly queueName: string;
	readonly idempotencyKey: string;
	readonly body: JsonValue;
	readonly availableAt?: string;
	readonly actorKey?: string;
}

export interface ActorSignalEffectInput {
	readonly kind: "actor-signal";
	readonly actorKey: string;
	readonly idempotencyKey: string;
	readonly body: JsonValue;
}

export interface TimerEffectInput {
	readonly kind: "timer";
	readonly timerId?: string;
	readonly timerKind: "sleep" | "reminder";
	readonly subjectId: string;
	readonly idempotencyKey: string;
	readonly dueAt: string;
	readonly payload?: unknown;
}

export interface CronEffectInput {
	readonly kind: "cron";
	readonly scheduleId: string;
	readonly everyMs: number;
	readonly startAt: string;
	readonly nextFireAt: string;
	readonly occurrence?: number;
}

export interface OutboxEffectInput {
	readonly kind: "outbox";
	readonly destination: string;
	readonly idempotencyKey: string;
	readonly payload: JsonValue;
	readonly headers?: Record<string, string>;
	readonly availableAt?: string;
}

export type DurableEffectInput =
	| QueueEffectInput
	| ActorSignalEffectInput
	| TimerEffectInput
	| CronEffectInput
	| OutboxEffectInput;

export interface DurableEffectReceipt {
	readonly kind: DurableEffectKind;
	readonly id: string;
	readonly idempotencyKey: string;
	readonly deduped: boolean;
}

export interface DurableCommitRequest {
	readonly streamId: string;
	readonly events: readonly EventInput[];
	readonly append: AppendOptions;
	readonly effects?: readonly DurableEffectInput[];
}

export interface DurableCommitResult extends AppendResult {
	readonly effects: readonly DurableEffectReceipt[];
}

// ── Durable subscriptions (checkpoint + lease, not live-only) ───────────────

export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };
export type PartitionId = string & { readonly __brand: "PartitionId" };

export interface SubscriptionCheckpoint {
	readonly subscriptionId: SubscriptionId;
	readonly partitionId: PartitionId;
	readonly position: EventPosition;
	readonly fenceToken: FenceToken;
	readonly updatedAt: string;
}

export interface SubscriptionLease {
	readonly subscriptionId: SubscriptionId;
	readonly partitionId: PartitionId;
	readonly holderId: string;
	readonly fenceToken: FenceToken;
	readonly expiresAt: string;
}

export interface ClaimSubscriptionOptions {
	readonly subscriptionId: string;
	readonly partitionId: string;
	readonly holderId: string;
	readonly leaseTtlMs?: number;
}

export interface CommitCheckpointOptions {
	readonly subscriptionId: string;
	readonly partitionId: string;
	readonly position: EventPosition | bigint;
	readonly fenceToken: bigint;
}

export interface ResetCheckpointOptions {
	readonly subscriptionId: string;
	readonly partitionId: string;
	readonly position: EventPosition | bigint;
	/** Administrative reset; bypasses monotonic check. */
	readonly administrative: true;
	readonly holderId: string;
}

/**
 * Internal durable EventStore + runtime journal capability.
 * App authors should not depend on this directly; runtimes wire it.
 */
export interface DurableEventStore extends EventStore {
	/** Catch-up reads by database-local position within this partition. */
	readAll(options?: ReadAllOptions): AsyncIterable<PositionedEvent>;
	/** Atomic domain events + staged runtime effects. */
	commit(request: DurableCommitRequest): Promise<DurableCommitResult>;
	loadSnapshot?<S>(streamId: string): Promise<SnapshotRecord<S> | undefined>;
	claimSubscription?(
		options: ClaimSubscriptionOptions,
	): Promise<SubscriptionLease>;
	renewSubscription?(
		options: ClaimSubscriptionOptions & { fenceToken: bigint },
	): Promise<SubscriptionLease>;
	releaseSubscription?(options: {
		subscriptionId: string;
		partitionId: string;
		holderId: string;
		fenceToken: bigint;
	}): Promise<void>;
	loadCheckpoint?(options: {
		subscriptionId: string;
		partitionId: string;
	}): Promise<SubscriptionCheckpoint | undefined>;
	commitCheckpoint?(
		options: CommitCheckpointOptions,
	): Promise<SubscriptionCheckpoint>;
	resetCheckpoint?(
		options: ResetCheckpointOptions,
	): Promise<SubscriptionCheckpoint>;
}

// ── Parse boundaries ────────────────────────────────────────────────────────

export class EventStoreParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_EVENTSTORE_PARSE", path, expected, received, message);
		this.name = "EventStoreParseError";
	}
}

function errorReceived<T>(value: T): JsonValue | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (isJsonString(value)) return value;
	if (isJsonNumber(value)) return value;
	if (isJsonBoolean(value)) return value;
	if (isJsonObject(value)) return value;
	if (isJsonArray(value)) return value;
	if (isJsonBigInt(value)) return value.toString();
	return String(value);
}

export function parseEventPosition<T>(
	value: T,
	path = "position",
): EventPosition {
	if (isJsonBigInt(value)) {
		const amount: bigint = value;
		if (amount < 0n) {
			throw new EventStoreParseError(
				path,
				"non-negative bigint",
				errorReceived(value),
			);
		}
		// SAFETY: parse already proved a non-negative bigint position.
		return amount as EventPosition;
	}
	if (isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0) {
		// SAFETY: assertion required at this I/O or test boundary.
		return BigInt(value) as EventPosition;
	}
	if (isJsonString(value) && /^(0|[1-9]\d*)$/.test(value)) {
		// SAFETY: assertion required at this I/O or test boundary.
		return BigInt(value) as EventPosition;
	}
	throw new EventStoreParseError(
		path,
		"non-negative integer/bigint",
		errorReceived(value),
	);
}

export function parseFenceToken<T>(value: T, path = "fenceToken"): FenceToken {
	if (isJsonBigInt(value)) {
		const amount: bigint = value;
		if (amount < 0n) {
			throw new EventStoreParseError(
				path,
				"non-negative bigint",
				errorReceived(value),
			);
		}
		// SAFETY: parse already proved a non-negative bigint fence token.
		return amount as FenceToken;
	}
	if (isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0) {
		// SAFETY: assertion required at this I/O or test boundary.
		return BigInt(value) as FenceToken;
	}
	if (isJsonString(value) && /^(0|[1-9]\d*)$/.test(value)) {
		// SAFETY: assertion required at this I/O or test boundary.
		return BigInt(value) as FenceToken;
	}
	throw new EventStoreParseError(
		path,
		"non-negative integer/bigint",
		errorReceived(value),
	);
}

export function parseSubscriptionId(
	value: JsonValue | undefined,
): SubscriptionId {
	if (!isJsonString(value) || value.length === 0) {
		throw new EventStoreParseError("subscriptionId", "non-empty string", value);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return value as SubscriptionId;
}

export function parsePartitionId(value: JsonValue | undefined): PartitionId {
	if (!isJsonString(value) || value.length === 0) {
		throw new EventStoreParseError("partitionId", "non-empty string", value);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return value as PartitionId;
}

export function fenceTokenToText(token: bigint): string {
	return token.toString(10);
}

export function eventPositionToText(position: bigint): string {
	return position.toString(10);
}

// ── Typed errors with stable codes ──────────────────────────────────────────

export type EventStoreErrorCode =
	| "OPTIMISTIC_SEQUENCE_CONFLICT"
	| "STALE_FENCE"
	| "MISSING_FENCE"
	| "LEASE_CONFLICT"
	| "SUBSCRIPTION_LEASE_CONFLICT"
	| "CHECKPOINT_REGRESSION"
	| "UNSUPPORTED_SCHEMA_VERSION"
	| "MIGRATION_FAILURE"
	| "UNSUPPORTED_CODEC"
	| "PERSISTENCE_UNAVAILABLE"
	| "SQLITE_BUSY"
	| "INTEGRITY_FAILURE"
	| "SNAPSHOT_AHEAD"
	| "STORAGE_WORKER_TERMINATED"
	| "STORAGE_WORKER_PROTOCOL_MISMATCH"
	| "INVALID_INPUT"
	| "STREAM_INTEGRITY";

export class EventStoreError extends Error {
	readonly code: EventStoreErrorCode;
	constructor(code: EventStoreErrorCode, message: string) {
		super(message);
		this.name = "EventStoreError";
		this.code = code;
	}
}

/** Stale expectedSeq — optimistic concurrency conflict. */
export class OptimisticSequenceConflictError extends EventStoreError {
	readonly streamId: string;
	readonly expectedSeq: number;
	readonly actualSeq: number;
	constructor(streamId: string, expectedSeq: number, actualSeq: number) {
		super(
			"OPTIMISTIC_SEQUENCE_CONFLICT",
			`stale expectedSeq for ${streamId}: expected ${expectedSeq}, actual ${actualSeq}`,
		);
		this.name = "OptimisticSequenceConflictError";
		this.streamId = streamId;
		this.expectedSeq = expectedSeq;
		this.actualSeq = actualSeq;
	}
}

/** Fencing token lower than stored owner epoch. */
export class StaleFenceError extends EventStoreError {
	readonly streamId: string;
	readonly provided: bigint;
	readonly stored: bigint;
	constructor(streamId: string, provided: bigint, stored: bigint) {
		super(
			"STALE_FENCE",
			`stale fence for ${streamId}: provided ${provided}, stored ${stored}`,
		);
		this.name = "StaleFenceError";
		this.streamId = streamId;
		this.provided = provided;
		this.stored = stored;
	}
}

/** Unfenced write against a stream that has entered fenced ownership. */
export class MissingFenceError extends EventStoreError {
	readonly streamId: string;
	readonly stored: bigint;
	constructor(streamId: string, stored: bigint) {
		super(
			"MISSING_FENCE",
			`fence required for ${streamId}: stored owner_epoch=${stored}`,
		);
		this.name = "MissingFenceError";
		this.streamId = streamId;
		this.stored = stored;
	}
}

export class SnapshotAheadError extends EventStoreError {
	readonly streamId: string;
	readonly snapshotSeq: number;
	readonly headSeq: number;
	constructor(streamId: string, snapshotSeq: number, headSeq: number) {
		super(
			"SNAPSHOT_AHEAD",
			`snapshot seq ${snapshotSeq} is ahead of ${streamId}@${headSeq}`,
		);
		this.name = "SnapshotAheadError";
		this.streamId = streamId;
		this.snapshotSeq = snapshotSeq;
		this.headSeq = headSeq;
	}
}

export class CheckpointRegressionError extends EventStoreError {
	readonly subscriptionId: string;
	readonly partitionId: string;
	readonly attempted: bigint;
	readonly current: bigint;
	constructor(
		subscriptionId: string,
		partitionId: string,
		attempted: bigint,
		current: bigint,
	) {
		super(
			"CHECKPOINT_REGRESSION",
			`checkpoint regression for ${subscriptionId}/${partitionId}: attempted ${attempted}, current ${current}`,
		);
		this.name = "CheckpointRegressionError";
		this.subscriptionId = subscriptionId;
		this.partitionId = partitionId;
		this.attempted = attempted;
		this.current = current;
	}
}

export class UnsupportedSchemaVersionError extends EventStoreError {
	readonly found: number;
	readonly supported: number;
	constructor(found: number, supported: number) {
		super(
			"UNSUPPORTED_SCHEMA_VERSION",
			`unsupported schema version ${found}; max supported is ${supported}`,
		);
		this.name = "UnsupportedSchemaVersionError";
		this.found = found;
		this.supported = supported;
	}
}

export class PersistenceUnavailableError extends EventStoreError {
	constructor(message: string) {
		super("PERSISTENCE_UNAVAILABLE", message);
		this.name = "PersistenceUnavailableError";
	}
}

export class SqliteBusyError extends EventStoreError {
	constructor(message = "sqlite busy / timeout") {
		super("SQLITE_BUSY", message);
		this.name = "SqliteBusyError";
	}
}

export class StorageWorkerTerminatedError extends EventStoreError {
	constructor(message = "storage worker terminated") {
		super("STORAGE_WORKER_TERMINATED", message);
		this.name = "StorageWorkerTerminatedError";
	}
}

export function isOptimisticConflict(error: Error): boolean {
	if (error instanceof OptimisticSequenceConflictError) return true;
	// SAFETY: assertion required at this I/O or test boundary.
	const name = (error as { name?: unknown })?.name;
	// SAFETY: assertion required at this I/O or test boundary.
	const code = (error as { code?: unknown })?.code;
	return (
		name === "OptimisticSequenceConflictError" ||
		name === "StaleSequenceError" ||
		code === "OPTIMISTIC_SEQUENCE_CONFLICT"
	);
}

export function isStaleFence(error: Error): boolean {
	if (error instanceof StaleFenceError) return true;
	// SAFETY: assertion required at this I/O or test boundary.
	const name = (error as { name?: unknown })?.name;
	// SAFETY: assertion required at this I/O or test boundary.
	const code = (error as { code?: unknown })?.code;
	return name === "StaleFenceError" || code === "STALE_FENCE";
}

/** Bounds for production APIs. */
export const EVENTSTORE_LIMITS = Object.freeze({
	maxBatchEvents: 256,
	maxReadPage: 1000,
	maxPayloadBytes: 1_048_576,
	maxMetadataBytes: 65_536,
	defaultBusyTimeoutMs: 5_000,
});

/**
 * Legacy/unfenced stream compatibility:
 * - owner_epoch = 0 means unfenced (legacy streams after migration).
 * - Unfenced appends (no fenceToken) are allowed only while owner_epoch === 0.
 * - First append with fenceToken > 0 sets owner_epoch and requires fencing thereafter.
 * - Unfenced writes to owner_epoch > 0 fail with MissingFenceError.
 */
export const FENCING_COMPAT = Object.freeze({
	UNFENCED_EPOCH: 0n,
	description:
		"Legacy streams start with owner_epoch=0; first fenced append enters fenced mode permanently for that stream.",
});
