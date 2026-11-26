import assert from "node:assert/strict";
import { test } from "vitest";

import {
	formatTraceparent,
	generateSpanId,
	generateTraceId,
	parseTraceContext,
	TrajectoryCaptureParseError,
} from "../src/index.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

test("parses a W3C traceparent into its parts", () => {
	const context = parseTraceContext(TRACEPARENT);
	assert.deepEqual(context, {
		traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
		spanId: "00f067aa0ba902b7",
		flags: "01",
	});
});

test("format(parse(x)) round-trips the traceparent", () => {
	assert.equal(formatTraceparent(parseTraceContext(TRACEPARENT)), TRACEPARENT);
});

test("parse(format(parts)) round-trips the parts", () => {
	const parts = {
		traceId: generateTraceId(),
		spanId: generateSpanId(),
		flags: "01",
	};
	assert.deepEqual(parseTraceContext(formatTraceparent(parts)), parts);
});

test("rejects malformed traceparents with a typed error", () => {
	const invalid = [
		undefined,
		42,
		"",
		"not-a-traceparent",
		// unsupported version
		"01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		// uppercase hex
		"00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
		// short trace id
		"00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01",
		// all-zero trace id
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01",
		// all-zero span id
		"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
	];
	for (const value of invalid) {
		assert.throws(
			() => parseTraceContext(value),
			(error: unknown) =>
				error instanceof TrajectoryCaptureParseError &&
				error.code === "HOBO_TRAINING_TRAJECTORY_PARSE",
			`expected typed parse error for ${String(value)}`,
		);
	}
});

test("refuses to format invalid trace context parts", () => {
	assert.throws(
		() =>
			formatTraceparent({
				traceId: "0".repeat(32),
				spanId: "00f067aa0ba902b7",
				flags: "01",
			}),
		TrajectoryCaptureParseError,
	);
	assert.throws(
		() =>
			formatTraceparent({
				traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
				spanId: "nope",
				flags: "01",
			}),
		TrajectoryCaptureParseError,
	);
	assert.throws(
		() =>
			formatTraceparent({
				traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
				spanId: "00f067aa0ba902b7",
				flags: "zz",
			}),
		TrajectoryCaptureParseError,
	);
});

test("generated ids are well-formed and non-zero", () => {
	for (let i = 0; i < 32; i += 1) {
		assert.match(generateTraceId(), /^[0-9a-f]{32}$/);
		assert.match(generateSpanId(), /^[0-9a-f]{16}$/);
		assert.notEqual(generateTraceId(), "0".repeat(32));
		assert.notEqual(generateSpanId(), "0".repeat(16));
	}
});
