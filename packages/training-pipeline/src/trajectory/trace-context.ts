import { randomBytes } from "node:crypto";
import type { JsonValue } from "@bufbuild/protobuf";
import { CoreParseError, diagnosticJson } from "@hobo/core";

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

export interface TraceContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly flags: string;
}

function fail(path: string, expected: string, received: unknown): never {
	throw new TrajectoryCaptureParseError(
		path,
		expected,
		diagnosticJson(received),
	);
}

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
	const [, traceId, spanId, flags] = match;
	if (traceId === undefined || spanId === undefined || flags === undefined) {
		fail("traceparent", "W3C traceparent fields", value);
	}
	if (traceId === ZERO_TRACE_ID) {
		fail("traceparent.traceId", "non-zero trace id", traceId);
	}
	if (spanId === ZERO_SPAN_ID) {
		fail("traceparent.spanId", "non-zero span id", spanId);
	}
	return Object.freeze({ traceId, spanId, flags });
}

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

export function generateTraceId(): string {
	let value = ZERO_TRACE_ID;
	while (value === ZERO_TRACE_ID) {
		value = randomBytes(16).toString("hex");
	}
	return value;
}

export function generateSpanId(): string {
	let value = ZERO_SPAN_ID;
	while (value === ZERO_SPAN_ID) {
		value = randomBytes(8).toString("hex");
	}
	return value;
}
