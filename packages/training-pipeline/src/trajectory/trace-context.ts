import { randomBytes } from "node:crypto";
import type { JsonValue } from "@bufbuild/protobuf";
import { CoreParseError, diagnosticJson } from "@hobo/core";

// W3C trace-context (traceparent) parse/format for trajectory capture
// (IMPL-003 trajectory-capture slice; trace-context-propagation-contract
// proof). Version 00 only; all-zero trace/span ids are invalid per the spec.
// Parse, don't validate: callers get decomposed parts or a typed error —
// never a boolean.

export class TrajectoryCaptureParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_TRAINING_TRAJECTORY_PARSE", path, expected, received, message);
		this.name = "TrajectoryCaptureParseError";
	}
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const FLAGS_PATTERN = /^[0-9a-f]{2}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

// domain-view: parse-don't-validate decomposed W3C trace context; its wire
// form is the traceparent string on the generated Trajectory
// (core data-models/training_engine.proto), not a parallel record shape.
export interface TraceContext {
	/** 32 lowercase hex characters, not all zeroes. */
	readonly traceId: string;
	/** 16 lowercase hex characters, not all zeroes. */
	readonly spanId: string;
	/** 2 hex characters (trace-flags), e.g. "01" = sampled. */
	readonly flags: string;
}

function fail(path: string, expected: string, received: unknown): never {
	throw new TrajectoryCaptureParseError(
		path,
		expected,
		diagnosticJson(received),
	);
}

/** Parses a W3C traceparent header value into its trace context parts. */
export function parseTraceContext(value: unknown): TraceContext {
	if (typeof value !== "string") {
		fail("traceparent", "W3C traceparent string", value);
	}
	const match = TRACEPARENT_PATTERN.exec(value);
	if (!match) {
		fail(
			"traceparent",
			"00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>",
			value,
		);
	}
	const [, traceId, spanId, flags] = match as unknown as [
		string,
		string,
		string,
		string,
	];
	if (traceId === ZERO_TRACE_ID) {
		fail("traceparent.traceId", "non-zero trace id", traceId);
	}
	if (spanId === ZERO_SPAN_ID) {
		fail("traceparent.spanId", "non-zero span id", spanId);
	}
	return Object.freeze({ traceId, spanId, flags });
}

/** Formats trace context parts back into a W3C traceparent header value. */
export function formatTraceparent(context: TraceContext): string {
	if (
		!TRACE_ID_PATTERN.test(context.traceId) ||
		context.traceId === ZERO_TRACE_ID
	) {
		fail("traceId", "32 lowercase hex characters, not all zeroes", {
			received: context.traceId,
		});
	}
	if (
		!SPAN_ID_PATTERN.test(context.spanId) ||
		context.spanId === ZERO_SPAN_ID
	) {
		fail("spanId", "16 lowercase hex characters, not all zeroes", {
			received: context.spanId,
		});
	}
	if (!FLAGS_PATTERN.test(context.flags)) {
		fail("flags", "2 hex characters", context.flags);
	}
	return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

/** Generates a random non-zero W3C trace id (32 lowercase hex). */
export function generateTraceId(): string {
	let value = ZERO_TRACE_ID;
	while (value === ZERO_TRACE_ID) {
		value = randomBytes(16).toString("hex");
	}
	return value;
}

/** Generates a random non-zero W3C span id (16 lowercase hex). */
export function generateSpanId(): string {
	let value = ZERO_SPAN_ID;
	while (value === ZERO_SPAN_ID) {
		value = randomBytes(8).toString("hex");
	}
	return value;
}
