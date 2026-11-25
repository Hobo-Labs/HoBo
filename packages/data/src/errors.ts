// Typed errors for the CQRS write-model kernel. Commands surface two failure
// classes an agent/caller must tell apart: an invariant violation (the command
// is illegal against current aggregate state — do NOT retry) and an optimistic
// concurrency conflict (someone else appended first — retry after re-folding).

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
	// SAFETY: `in` established `code`; tag check parses the string conflict signal.
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

// Thrown when an append is rejected because the stream advanced past the seq the
// command folded against. Retryable: re-load the stream, re-check invariants,
// re-append. Mirrors the runtime EventStore's OptimisticSequenceConflictError.
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

// A projection or materialization tried to reach a write capability. Read-model
// folds are deterministic + read-only by construction; this guards the boundary.
export class ProjectionWriteError extends Error {
	readonly code = "PROJECTION_WRITE_FORBIDDEN" as const;
	constructor(message: string) {
		super(message);
		this.name = "ProjectionWriteError";
	}
}

// Recognizes the runtime EventStore's optimistic-conflict signal without taking a
// hard dependency on the runtime package (inward-only: @hobo/data → @hobo/core).
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
