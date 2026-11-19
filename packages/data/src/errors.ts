import type { EventEnvelope, QuarantineRecord } from "@hobo/core";
import { type ErrorSignal, isJsonString } from "./json.js";

export type { ErrorSignal } from "./json.js";

function errorName(
	error: Error | ErrorSignal | null | undefined,
): string | undefined {
	if (error == null) return undefined;
	if (error instanceof Error) return error.name;
	return isJsonString(error.name) ? error.name : undefined;
}

function errorCode(
	error: Error | ErrorSignal | null | undefined,
): string | undefined {
	if (error == null) return undefined;
	if (!("code" in error)) return undefined;
	const code = (error as ErrorSignal).code;
	return isJsonString(code) ? code : undefined;
}

export class AggregateInvariantError extends Error {
	readonly code = "AGGREGATE_INVARIANT" as const;
	readonly retryable = false as const;
	constructor(message: string) {
		super(message);
		this.name = "AggregateInvariantError";
	}
}

export class AggregateConflictError extends Error {
	readonly code = "AGGREGATE_CONFLICT" as const;
	readonly retryable = true as const;
	readonly streamId: string;
	readonly expectedSeq: number;
	constructor(streamId: string, expectedSeq: number, message?: string) {
		super(
			message ??
				`optimistic conflict on ${streamId}: stream advanced past expectedSeq=${expectedSeq}`,
		);
		this.name = "AggregateConflictError";
		this.streamId = streamId;
		this.expectedSeq = expectedSeq;
	}
}

export class ProjectionWriteError extends Error {
	readonly code = "PROJECTION_WRITE_FORBIDDEN" as const;
	constructor(message: string) {
		super(message);
		this.name = "ProjectionWriteError";
	}
}

export class ProjectionFoldError extends Error {
	readonly projection: string;
	readonly streamId: string;
	readonly seq: number;
	readonly eventType: string;
	override readonly cause: Error;

	constructor(projection: string, event: EventEnvelope, cause: Error) {
		super(
			`projection ${projection} failed at ${event.streamId}@${event.seq} (${event.type}): ${cause.message}`,
			{ cause },
		);
		this.name = "ProjectionFoldError";
		this.projection = projection;
		this.streamId = event.streamId;
		this.seq = event.seq;
		this.eventType = event.type;
		this.cause = cause;
	}
}

export class DurableEffectUnavailableError extends Error {
	readonly code = "DURABLE_EFFECT_UNAVAILABLE" as const;
	constructor() {
		super("aggregate effects require a durable event store");
		this.name = "DurableEffectUnavailableError";
	}
}

export class UnpersistedQuarantineError extends Error {
	readonly code = "UNPERSISTED_QUARANTINE" as const;
	constructor(
		readonly streamId: string,
		readonly quarantined: readonly QuarantineRecord[],
	) {
		super(`aggregate stream ${streamId} has events requiring quarantine`);
		this.name = "UnpersistedQuarantineError";
	}
}

export function isOptimisticConflict(
	error: Error | ErrorSignal | null | undefined,
): boolean {
	if (error instanceof AggregateConflictError) return true;
	const name = errorName(error);
	const code = errorCode(error);
	return (
		name === "OptimisticSequenceConflictError" ||
		name === "StaleSequenceError" ||
		code === "OPTIMISTIC_SEQUENCE_CONFLICT"
	);
}

export function isStaleFenceError(
	error: Error | ErrorSignal | null | undefined,
): boolean {
	return (
		errorName(error) === "StaleFenceError" || errorCode(error) === "STALE_FENCE"
	);
}

export class AggregateStaleFenceError extends Error {
	readonly code = "STALE_FENCE" as const;
	readonly retryable = false as const;
	readonly streamId: string;
	constructor(streamId: string, message?: string) {
		super(message ?? `stale actor fence for ${streamId}`);
		this.name = "AggregateStaleFenceError";
		this.streamId = streamId;
	}
}
