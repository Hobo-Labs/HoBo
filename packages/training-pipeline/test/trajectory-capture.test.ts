import assert from "node:assert/strict";
import { test } from "vitest";

import type { SpanIdGenerator } from "../src/index.js";
import {
	createInMemorySpanExporter,
	createTrajectoryCapture,
	parseCapturedSpan,
	parseTraceContext,
	TrajectoryCaptureParseError,
} from "../src/index.js";

const INBOUND = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function sequentialIds(): SpanIdGenerator {
	let traceSeq = 0;
	let spanSeq = 0;
	return {
		traceId: () => (++traceSeq).toString(16).padStart(32, "0"),
		spanId: () => (++spanSeq).toString(16).padStart(16, "0"),
	};
}

function sequentialClock(
	startMs = Date.UTC(2026, 6, 25, 12, 0, 0),
): () => string {
	let tick = -1;
	return () => {
		tick += 1;
		return new Date(startMs + tick * 1000).toISOString();
	};
}

function capture(options: { traceparent?: string } = {}) {
	const exporter = createInMemorySpanExporter();
	const trajectoryCapture = createTrajectoryCapture({
		...(options.traceparent === undefined
			? {}
			: { traceparent: options.traceparent }),
		exporter,
		idGenerator: sequentialIds(),
		now: sequentialClock(),
	});
	return { exporter, capture: trajectoryCapture };
}

test("span lifecycle: start and end an agent span through the exporter", () => {
	const { exporter, capture: c } = capture({ traceparent: INBOUND });
	const handle = c.startSpan("support.classifyTicket", {
		kind: "AGENT",
		input: { subject: "site is down" },
	});
	assert.equal(c.openSpanCount(), 1);

	const span = handle.end({ output: { category: "outage" } });
	assert.equal(c.openSpanCount(), 0);
	assert.equal(c.finishedSpans().length, 1);
	assert.deepEqual(exporter.spans, [span]);

	assert.equal(span.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
	assert.equal(span.spanId, handle.spanId);
	assert.equal(span.parentSpanId, "");
	assert.equal(span.name, "support.classifyTicket");
	assert.equal(span.kind, "AGENT");
	assert.equal(span.startTime, "2026-07-25T12:00:00.000Z");
	assert.equal(span.endTime, "2026-07-25T12:00:01.000Z");
	assert.deepEqual(span.status, { code: "OK" });
});

test("spans carry the exact OpenInference semantic-convention keys", () => {
	const { capture: c } = capture();
	const span = c
		.startSpan("llm.generate", {
			kind: "LLM",
			input: { prompt: "classify" },
			attributes: { "llm.model_name": "example-model" },
		})
		.end({ output: { text: "outage" } });

	assert.deepEqual(Object.keys(span.attributes).sort(), [
		"input.mime_type",
		"input.value",
		"llm.model_name",
		"openinference.span.kind",
		"output.mime_type",
		"output.value",
	]);
	assert.equal(span.attributes["openinference.span.kind"], "LLM");
	assert.equal(span.attributes["input.value"], '{"prompt":"classify"}');
	assert.equal(span.attributes["input.mime_type"], "application/json");
	assert.equal(span.attributes["output.value"], '{"text":"outage"}');
	assert.equal(span.attributes["output.mime_type"], "application/json");
});

test("each agent action maps to its OpenInference span kind", () => {
	const { capture: c } = capture();
	const root = c.startSpan("agent.step", { kind: "AGENT" });
	const tool = c.startSpan("tool.lookup", { kind: "TOOL", parent: root });
	const llm = c.startSpan("llm.call", { kind: "LLM", parent: root });
	const evaluator = c.startSpan("eval.rubric", {
		kind: "EVALUATOR",
		parent: root,
	});
	for (const [handle, kind] of [
		[tool, "TOOL"],
		[llm, "LLM"],
		[evaluator, "EVALUATOR"],
		[root, "AGENT"],
	] as const) {
		const span = handle.end();
		assert.equal(span.kind, kind);
		assert.equal(span.attributes["openinference.span.kind"], kind);
	}
});

test("propagates W3C trace context parent to child", () => {
	const { capture: c } = capture({ traceparent: INBOUND });
	assert.equal(c.traceparent, INBOUND);
	assert.equal(c.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");

	const root = c.startSpan("agent.step", { kind: "AGENT" });
	const rootContext = parseTraceContext(root.traceparent);
	assert.equal(rootContext.traceId, c.traceId);
	assert.equal(rootContext.spanId, root.spanId);
	assert.equal(rootContext.flags, "01");

	const child = c.startSpan("tool.call", { kind: "TOOL", parent: root });
	const childContext = parseTraceContext(child.traceparent);
	assert.equal(childContext.traceId, c.traceId);
	assert.equal(childContext.spanId, child.spanId);

	const childSpan = child.end();
	assert.equal(childSpan.parentSpanId, root.spanId);
	root.end();
});

test("starts a fresh trace when no traceparent is inbound", () => {
	const { capture: c } = capture();
	const context = parseTraceContext(c.traceparent);
	assert.equal(context.traceId, c.traceId);
	const span = c.startSpan("agent.step", { kind: "AGENT" }).end();
	assert.equal(span.traceId, c.traceId);
	assert.equal(span.parentSpanId, "");
});

test("rejects an invalid inbound traceparent with a typed error", () => {
	assert.throws(
		() => createTrajectoryCapture({ traceparent: "garbage" }),
		TrajectoryCaptureParseError,
	);
});

test("rejects unknown span kinds, empty names, and closed parents", () => {
	const { capture: c } = capture();
	assert.throws(
		() => c.startSpan("bad.kind", { kind: "SERVER" as unknown as "AGENT" }),
		TrajectoryCaptureParseError,
	);
	assert.throws(
		() => c.startSpan("   ", { kind: "AGENT" }),
		TrajectoryCaptureParseError,
	);
	const root = c.startSpan("agent.step", { kind: "AGENT" });
	root.end();
	assert.throws(
		() => c.startSpan("tool.late", { kind: "TOOL", parent: root }),
		TrajectoryCaptureParseError,
	);
});

test("ending a span twice is a typed error", () => {
	const { capture: c } = capture();
	const handle = c.startSpan("agent.step", { kind: "AGENT" });
	handle.end();
	assert.throws(() => handle.end(), TrajectoryCaptureParseError);
});

test("a clock that is not ISO-8601 or runs backwards is a typed error", () => {
	const broken = createTrajectoryCapture({ now: () => "not-a-timestamp" });
	assert.throws(
		() => broken.startSpan("agent.step", { kind: "AGENT" }),
		TrajectoryCaptureParseError,
	);

	const times = ["2026-07-25T12:00:01.000Z", "2026-07-25T12:00:00.000Z"];
	let tick = 0;
	const backwards = createTrajectoryCapture({
		now: () => times[tick++] ?? "2026-07-25T12:00:00.000Z",
	});
	const handle = backwards.startSpan("agent.step", { kind: "AGENT" });
	assert.throws(() => handle.end(), TrajectoryCaptureParseError);
});

test("parseCapturedSpan rejects unfinished spans and bad timestamps", () => {
	const valid = {
		traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
		spanId: "00f067aa0ba902b7",
		parentSpanId: "",
		name: "agent.step",
		kind: "AGENT",
		startTime: "2026-07-25T12:00:00.000Z",
		endTime: "2026-07-25T12:00:01.000Z",
		attributes: { "openinference.span.kind": "AGENT" },
		status: { code: "OK" },
	};
	assert.equal(parseCapturedSpan(valid).spanId, "00f067aa0ba902b7");

	const cases: Record<string, unknown>[] = [
		{ ...valid, endTime: undefined }, // unfinished
		{ ...valid, endTime: "" }, // unfinished
		{ ...valid, startTime: "1969-12-31T23:59:59.000Z" }, // pre-epoch
		{ ...valid, endTime: "2026-07-25T11:59:59.000Z" }, // ends before start
		{ ...valid, startTime: "yesterday" },
		{ ...valid, traceId: "0".repeat(32) },
		{ ...valid, spanId: "xyz" },
		{ ...valid, kind: "SERVER" },
		{ ...valid, status: { code: "MAYBE" } },
		{ ...valid, attributes: { key: 42 } },
	];
	for (const record of cases) {
		assert.throws(
			() => parseCapturedSpan(record),
			(error: unknown) =>
				error instanceof TrajectoryCaptureParseError &&
				error.code === "HOBO_TRAINING_TRAJECTORY_PARSE",
			`expected typed parse error for ${JSON.stringify(record)}`,
		);
	}
});
