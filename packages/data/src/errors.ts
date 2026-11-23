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
