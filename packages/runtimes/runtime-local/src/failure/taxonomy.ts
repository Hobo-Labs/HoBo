/**
 * Membrane failure taxonomy (S1-23).
 *
 * Every cross-membrane call — a wRPC link — is a **timeout boundary** and a
 * **fail-closed boundary**. When a call cannot complete cleanly it surfaces a
 * *typed* error whose `kind` maps onto the WIT `hobo:runtime` `runtime-error`
 * variant (`packages/wit/wit/deps/hobo-runtime/hobo-runtime.wit`):
 *
 *   retryable | fatal | cancelled | version-incompatible | ambiguous-commit
 *
 * The taxonomy never invents kinds outside that variant. `ambiguous-commit`
 * (the call may or may not have committed) is surfaced explicitly and is never
 * silently retried. An unrecognized failure classifies to `fatal` — fail
 * closed, never optimistically retried.
 *
 * The proto/CUE wire form of these records lives in
 * `data-models/failure_taxonomy.{proto,cue}`.
 */

import { isJsonNumber, isJsonString, type JsonValue } from "../json.js";

export type RuntimeErrorKind =
	| "retryable"
	| "fatal"
	| "cancelled"
	| "version-incompatible"
	| "ambiguous-commit";

export const RUNTIME_ERROR_KINDS = Object.freeze([
	"retryable",
	"fatal",
	"cancelled",
	"version-incompatible",
	"ambiguous-commit",
] as const) satisfies readonly RuntimeErrorKind[];

/** WIT variant lowering: `{ tag, val }` mirrors `result<_, runtime-error>`. */
export interface RuntimeErrorVariant {
	readonly tag: RuntimeErrorKind;
	readonly val: string;
}

export function isRuntimeErrorKind(
	value: JsonValue,
): value is RuntimeErrorKind {
	return (
		isJsonString(value) &&
		// SAFETY: assertion to `E_ERROR_KINDS as readonly string[]).incl` is required at this boundary.
		(RUNTIME_ERROR_KINDS as readonly string[]).includes(value)
	);
}

/**
 * Base class for every typed membrane failure. Each subclass fixes its WIT
 * `kind`; `toVariant()` lowers to the `runtime-error` wire shape.
 */
export class RuntimeMembraneError extends Error {
	readonly kind: RuntimeErrorKind;
	readonly retryable: boolean;
	readonly ambiguousCommit: boolean;

	constructor(
		kind: RuntimeErrorKind,
		message: string,
		options: { retryable?: boolean; ambiguousCommit?: boolean } = {},
	) {
		super(message);
		this.name = "RuntimeMembraneError";
		this.kind = kind;
		this.retryable = options.retryable ?? kind === "retryable";
		this.ambiguousCommit =
			options.ambiguousCommit ?? kind === "ambiguous-commit";
	}

	toVariant(): RuntimeErrorVariant {
		return Object.freeze({ tag: this.kind, val: this.message });
	}
}

export interface DeadlineExceededArgs {
	componentId: string;
	importInterface: string;
	operation: string;
	deadline: string;
	deadlineMs: number;
	observedNowMs: number;
}

/**
 * A carried deadline elapsed before the provider produced a result. The call
 * is cancelled and fails closed — `cancelled` per the WIT taxonomy.
 */
export class DeadlineExceededError extends RuntimeMembraneError {
	readonly code = "deadline-exceeded" as const;
	readonly componentId: string;
	readonly importInterface: string;
	readonly operation: string;
	readonly deadline: string;
	readonly deadlineMs: number;
	readonly observedNowMs: number;

	constructor(args: DeadlineExceededArgs) {
		super(
			"cancelled",
			`wrpc.deadline_exceeded: ${args.componentId}:${args.importInterface}.${args.operation} exceeded deadline ${args.deadline}`,
		);
		this.name = "DeadlineExceededError";
		this.componentId = args.componentId;
		this.importInterface = args.importInterface;
		this.operation = args.operation;
		this.deadline = args.deadline;
		this.deadlineMs = args.deadlineMs;
		this.observedNowMs = args.observedNowMs;
	}
}

export interface MembraneBackpressureArgs {
	providerId: string;
	operation: string;
	importInterface: string;
	maxInFlight: number;
	inFlight: number;
}

/**
 * The membrane is saturated: in-flight calls to a provider reached the bound,
 * so the call is shed rather than buffered unboundedly. Backpressure is
 * `retryable` — the caller may retry once headroom returns.
 */
export class MembraneBackpressureError extends RuntimeMembraneError {
	readonly code = "membrane-backpressure" as const;
	readonly membrane = "overloaded" as const;
	readonly providerId: string;
	readonly operation: string;
	readonly importInterface: string;
	readonly maxInFlight: number;
	readonly inFlight: number;

	constructor(args: MembraneBackpressureArgs) {
		super(
			"retryable",
			`wrpc.backpressure: ${args.providerId}.${args.operation} saturated (${args.inFlight}/${args.maxInFlight} in flight)`,
			{ retryable: true },
		);
		this.name = "MembraneBackpressureError";
		this.providerId = args.providerId;
		this.operation = args.operation;
		this.importInterface = args.importInterface;
		this.maxInFlight = args.maxInFlight;
		this.inFlight = args.inFlight;
	}
}

export interface AmbiguousCommitArgs {
	providerId: string;
	operation: string;
	importInterface: string;
	reason?: string;
}

/**
 * A mid-call failure whose commit status is unknown — the effect may or may
 * not have been applied. Surfaced explicitly as `ambiguous-commit` and never
 * silently retried; the caller must forward an idempotency key or refresh
 * before acting.
 */
export class AmbiguousCommitError extends RuntimeMembraneError {
	readonly code = "ambiguous-commit" as const;
	readonly membrane = "severed" as const;
	readonly providerId: string;
	readonly operation: string;
	readonly importInterface: string;
	readonly reason: string;

	constructor(args: AmbiguousCommitArgs) {
		const reason = args.reason ?? "provider severed mid-call; commit unknown";
		super(
			"ambiguous-commit",
			`wrpc.ambiguous_commit: ${args.providerId}.${args.operation} ${reason}`,
			{ ambiguousCommit: true },
		);
		this.name = "AmbiguousCommitError";
		this.providerId = args.providerId;
		this.operation = args.operation;
		this.importInterface = args.importInterface;
		this.reason = reason;
	}
}

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Fail-closed classifier: maps any thrown value onto exactly one WIT
 * `runtime-error` variant. Recognized typed failures keep their kind; an
 * unrecognized error is `fatal` (never optimistically retried).
 */
export function classifyToRuntimeError(error: Error): RuntimeErrorVariant {
	if (error instanceof RuntimeMembraneError) {
		return error.toVariant();
	}

	interface ErrorBag {
		readonly code?: JsonValue;
		readonly membrane?: JsonValue;
		readonly reason?: JsonValue;
		readonly ambiguousCommit?: JsonValue;
		readonly retryable?: JsonValue;
		readonly status?: JsonValue;
	}
	// SAFETY: membrane errors carry optional code/reason bags at this boundary.
	const record = error as ErrorBag;
	const code = isJsonString(record.code) ? record.code.toLowerCase() : "";
	const membrane = isJsonString(record.membrane)
		? record.membrane.toLowerCase()
		: "";
	const message =
		error instanceof Error ? error.message : String(error ?? "unknown");

	if (
		code === "version-incompatible" ||
		record.reason === "no-shared-minor" ||
		record.reason === "shared-minor-below-floor"
	) {
		return variant("version-incompatible", message);
	}

	if (
		record.ambiguousCommit === true ||
		code === "ambiguous-commit" ||
		code === "ambiguous-return" ||
		membrane === "severed" ||
		membrane === "ambiguous-return"
	) {
		return variant("ambiguous-commit", message);
	}

	if (code === "cancelled" || code === "deadline-exceeded") {
		return variant("cancelled", message);
	}

	const status = isJsonNumber(record.status) ? record.status : undefined;
	if (
		record.retryable === true ||
		membrane === "overloaded" ||
		code === "membrane-backpressure" ||
		code === "timeout" ||
		(status !== undefined && RETRYABLE_HTTP_STATUS.has(status))
	) {
		return variant("retryable", message);
	}

	return variant("fatal", message);
}

function variant(tag: RuntimeErrorKind, val: string): RuntimeErrorVariant {
	return Object.freeze({ tag, val });
}
