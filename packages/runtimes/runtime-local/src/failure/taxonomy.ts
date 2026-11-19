
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

export interface RuntimeErrorVariant {
	readonly tag: RuntimeErrorKind;
	readonly val: string;
}

export function isRuntimeErrorKind(
	value: JsonValue,
): value is RuntimeErrorKind {
	return (
		isJsonString(value) &&
		(RUNTIME_ERROR_KINDS as readonly string[]).includes(value)
	);
}

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
