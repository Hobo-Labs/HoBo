import assert from "node:assert/strict";
import { OpenInferenceSpanKind, parseTrajectory } from "@hobo/core";
import { test } from "vitest";

import type { AssembleTrajectoryOptions, CapturedSpan } from "../src/index.js";
import {
	assembleTrajectory,
	createTrajectoryCapture,
	evaluatePromotionGate,
	parseEvalResult,
	parsePromotionThresholds,
	parseTraceContext,
	promotionEventNames,
	TRAINING_TRAJECTORY_CAPTURED,
	TrajectoryCaptureParseError,
	trajectoryCapturedEvent,
} from "../src/index.js";

const ASSEMBLE_OPTIONS: AssembleTrajectoryOptions = {
	id: "trajectory-run-1-1",
	run: {
		id: "run-1",
		tenantId: "tenant-a",
		bindle: "bindle/support",
		agent: {
			id: "agent:support-classifier",
			principalRef: "spiffe://tenant-a/bindle/support/agent/support-classifier",
		},
	},
	subject: {
		method: "classifyTicket",
		contractRef: "contract://support/classification@1.0.0",
		generatedRegion: {
			regionId: "region-classifyTicket-body",
			artifactRef: "git://repo/src/support.ts#classifyTicket",
			startOffset: 0,
			endOffset: 80,
			owner: "training-engine",
		},
	},
	reward: {
		source: "capture",
		rubricRef: "rubric://support/classifier@1.0.0",
	},
};

function sequentialClock(): () => string {
	let tick = -1;
	return () => {
		tick += 1;
		return new Date(Date.UTC(2026, 6, 25, 12, 0, tick)).toISOString();
	};
}

function capturedRun() {
	const capture = createTrajectoryCapture({ now: sequentialClock() });
	const root = capture.startSpan("support.classifyTicket", {
		kind: "AGENT",
		input: { subject: "site is down" },
	});
	const tool = capture.startSpan("tool.searchStatusPage", {
		kind: "TOOL",
		parent: root,
	});
	tool.end({ output: { incidents: 1 } });
	const llm = capture.startSpan("llm.classify", { kind: "LLM", parent: root });
	llm.end({ output: { category: "outage" } });
	root.end({ output: { category: "outage" } });
	return { capture, root };
}

test("assembles finished spans into the stored Trajectory record", () => {
	const { capture, root } = capturedRun();
	const captured = capture.toTrajectory(ASSEMBLE_OPTIONS);

	assert.equal(captured.trajectory.id, "trajectory-run-1-1");
	assert.equal(captured.trajectory.spans.length, 3);

	const context = parseTraceContext(captured.trajectory.traceparent);
	assert.equal(context.traceId, capture.traceId);
	assert.equal(context.spanId, root.spanId);

	const rootSpan = captured.trajectory.spans.find(
		(span) => span.parentId === "",
	);
	assert.ok(rootSpan, "assembled trajectory has a root span");
	assert.equal(rootSpan.id, root.spanId);
	assert.equal(rootSpan.kind, OpenInferenceSpanKind.AGENT);
	assert.equal(rootSpan.outputsJson, '{"category":"outage"}');
	assert.equal(rootSpan.inputsJson, '{"subject":"site is down"}');
	assert.equal(rootSpan.attributes["openinference.span.kind"], "AGENT");
	assert.equal(rootSpan.attributes["otel.status_code"], "OK");

	for (const span of captured.trajectory.spans) {
		if (span.id === root.spanId) continue;
		assert.equal(span.parentId, root.spanId);
	}
});

test("the assembled record round-trips its proto-JSON wire form", () => {
	const { capture } = capturedRun();
	const captured = capture.toTrajectory(ASSEMBLE_OPTIONS);
	const reparsed = parseTrajectory(
		JSON.parse(JSON.stringify(captured.trajectoryJson)),
	);
	assert.deepEqual(reparsed, captured.trajectory);
	assert.match(captured.hash, /^sha256:[a-f0-9]{64}$/);
});

test("a remote inbound parent lowers to a local root span", () => {
	const capture = createTrajectoryCapture({
		traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		now: sequentialClock(),
	});
	capture
		.startSpan("support.classifyTicket", { kind: "CHAIN" })
		.end({ output: { category: "outage" } });
	const captured = capture.toTrajectory(ASSEMBLE_OPTIONS);
	const rootSpan = captured.trajectory.spans[0];
	assert.ok(rootSpan);
	assert.equal(rootSpan.parentId, "");
	assert.equal(
		parseTraceContext(captured.trajectory.traceparent).traceId,
		"4bf92f3577b34da6a3ce929d0e0e4736",
	);
});

test("refuses to assemble while spans are still open", () => {
	const capture = createTrajectoryCapture({ now: sequentialClock() });
	capture.startSpan("support.classifyTicket", { kind: "AGENT" });
	assert.throws(
		() => capture.toTrajectory(ASSEMBLE_OPTIONS),
		TrajectoryCaptureParseError,
	);
});

test("assembly rejects invalid span sets with typed errors", () => {
	const { capture } = capturedRun();
	const spans = capture.finishedSpans();
	const first = spans[0] as CapturedSpan;

	// no spans at all
	assert.throws(
		() => assembleTrajectory([], ASSEMBLE_OPTIONS),
		TrajectoryCaptureParseError,
	);
	// two roots
	assert.throws(
		() =>
			assembleTrajectory(
				[...spans, { ...first, spanId: "aaaaaaaaaaaaaaaa", parentSpanId: "" }],
				ASSEMBLE_OPTIONS,
			),
		TrajectoryCaptureParseError,
	);
	// duplicate span ids
	assert.throws(
		() => assembleTrajectory([...spans, first], ASSEMBLE_OPTIONS),
		TrajectoryCaptureParseError,
	);
	// mixed trace ids
	assert.throws(
		() =>
			assembleTrajectory(
				[
					...spans,
					{
						...first,
						spanId: "aaaaaaaaaaaaaaaa",
						traceId: "b".repeat(32),
						parentSpanId: first.spanId,
					},
				],
				ASSEMBLE_OPTIONS,
			),
		TrajectoryCaptureParseError,
	);
});

test("wraps the captured trajectory as a training.* family event", () => {
	const { capture } = capturedRun();
	const captured = capture.toTrajectory(ASSEMBLE_OPTIONS);
	const event = trajectoryCapturedEvent(captured, {
		eventId: "evt-1",
		seq: 7,
		ts: "2026-07-25T12:00:10.000Z",
		actor: { kind: "agent", id: "agent:support-classifier" },
		correlationId: "corr-1",
	});

	assert.equal(event.type, TRAINING_TRAJECTORY_CAPTURED);
	assert.equal(event.type, "training.TrajectoryCaptured");
	assert.equal(event.streamId, "training:run-1");
	assert.equal(event.tenant, "tenant-a");
	assert.equal(event.seq, 7);
	assert.deepEqual(event.meta, {
		traceparent: captured.trajectory.traceparent,
	});
	const data = event.data as Record<string, unknown>;
	assert.equal(data.trajectoryId, captured.trajectory.id);
	assert.equal(data.trajectoryHash, captured.hash);
	assert.deepEqual(data.trajectory, captured.trajectoryJson);
});

test("capture and promotion facts ride the same event families", () => {
	const decision = evaluatePromotionGate({
		candidateId: "candidate-1",
		conformance: true,
		policy: true,
		evalResult: parseEvalResult({
			rubricRef: "rubric://support/classifier@1.0.0",
			scores: { accuracy: 0.95 },
			sampleCount: 128,
			source: "live-eval",
		}),
		thresholds: parsePromotionThresholds({
			metricFloors: { accuracy: 0.85 },
			minSamples: 100,
		}),
	});
	const eventNames = [
		TRAINING_TRAJECTORY_CAPTURED,
		...promotionEventNames(decision),
	];
	assert.deepEqual(eventNames, [
		"training.TrajectoryCaptured",
		"training.Promoted",
		"impl.Promoted",
	]);
	for (const name of eventNames) {
		assert.match(name, /^(training|impl|eval)\.[A-Z][A-Za-z0-9]*$/);
	}
});
