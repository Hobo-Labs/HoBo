import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonObject } from "../src/json.js";

import {
	hashTrajectory,
	parseOptimizeRequest,
	parseTrainingArtifact,
	parseTrainingCandidate,
	parseTrajectory,
	TrainingEngineParseError,
} from "../src/ports/training-engine.js";

const TRAJECTORY_HASH = `sha256:${"a".repeat(64)}`;

function goldenRegion() {
	return {
		regionId: "region-classifyTicket-body",
		artifactRef: "git://repo/src/support.ts#classifyTicket",
		startOffset: 0,
		endOffset: 80,
		owner: "training-engine",
	};
}

function goldenTrajectory(overrides: JsonObject = {}) {
	return {
		id: "trajectory-1",
		traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		run: {
			id: "run-training-1",
			tenantId: "tenant-a",
			bindle: "bindle/support",
			agent: {
				id: "agent:support-classifier",
				principalRef:
					"spiffe://tenant-a/bindle/support/agent/support-classifier",
			},
		},
		subject: {
			method: "classifyTicket",
			contractRef: "contract://support/classification@1.0.0",
			generatedRegion: goldenRegion(),
		},
		spans: [
			{
				id: "span-root",
				kind: "OPEN_INFERENCE_SPAN_KIND_CHAIN",
				name: "support.classifyTicket",
				startTime: "2026-06-25T09:00:00.000Z",
				endTime: "2026-06-25T09:00:00.120Z",
				inputsJson: JSON.stringify({ subject: "cannot reset password" }),
				outputsJson: JSON.stringify({ category: "access" }),
			},
			{
				id: "span-llm",
				parentId: "span-root",
				kind: "OPEN_INFERENCE_SPAN_KIND_LLM",
				name: "llm.classifyTicket",
				startTime: "2026-06-25T09:00:00.010Z",
				endTime: "2026-06-25T09:00:00.100Z",
				attributes: { "llm.model_name": "stub-classifier" },
			},
		],
		payloads: {
			"ticket.intent": {
				classification: "public",
				redaction: "none",
				valueJson: JSON.stringify("password-reset"),
			},
		},
		reward: {
			source: "live-eval",
			rubricRef: "rubric://support/classifier@1.0.0",
			score: 0.94,
		},
		...overrides,
	};
}

function goldenOptimizeRequest() {
	return {
		requestId: "optimize-request-1",
		generatedRegion: goldenRegion(),
		trajectories: [goldenTrajectory()],
		rubric: {
			id: "rubric://support/classifier@1.0.0",
			objective: "maximize classification reward",
		},
		contract: {
			ref: "contract://support/classification@1.0.0",
			method: "classifyTicket",
			allowedRegionId: "region-classifyTicket-body",
		},
	};
}

function goldenArtifact() {
	return {
		engineId: "hobo.training-engine/built-in-opto@0.1.0",
		engineVersion: "22.0.9",
		methodRef: "classifyTicket",
		programJson: JSON.stringify({
			instructions: "Classify the ticket into a known category.",
			demos: [
				{
					inputJson: JSON.stringify({ subject: "site is down" }),
					outputJson: JSON.stringify({ category: "outage" }),
				},
			],
		}),
	};
}

test("parses a golden trajectory into the frozen generated type", () => {
	const trajectory = parseTrajectory(goldenTrajectory());
	assert.equal(trajectory.$typeName, "hobo.core.v1.Trajectory");
	assert.equal(trajectory.id, "trajectory-1");
	assert.equal(trajectory.spans.length, 2);
	assert.ok(Object.isFrozen(trajectory));
	assert.ok(Object.isFrozen(trajectory.reward));
});

test("rejects a malformed traceparent", () => {
	assert.throws(
		() => parseTrajectory(goldenTrajectory({ traceparent: "not-a-trace" })),
		TrainingEngineParseError,
	);
});

test("rejects an unknown OpenInference span kind", () => {
	const trajectory = goldenTrajectory();
	// SAFETY: assertion required at this I/O or test boundary.
	(trajectory.spans[0] as { kind: string }).kind = "MYSTERY";
	assert.throws(() => parseTrajectory(trajectory), TrainingEngineParseError);
});

test("rejects an unredacted sensitive payload (ADR-0099 fail-closed)", () => {
	const trajectory = goldenTrajectory({
		payloads: {
			"user.email": {
				classification: "pii",
				redaction: "none",
				valueJson: JSON.stringify("person@example.com"),
			},
		},
	});
	assert.throws(() => parseTrajectory(trajectory), TrainingEngineParseError);
});

test("accepts a tokenized sensitive payload", () => {
	const trajectory = parseTrajectory(
		goldenTrajectory({
			payloads: {
				"user.email": {
					classification: "pii",
					redaction: "tokenized",
					tokenRef: "token://tenant-a/abc",
				},
			},
		}),
	);
	assert.equal(trajectory.payloads["user.email"]?.redaction, "tokenized");
});

test("parses an optimize request and enforces region correlation", () => {
	const request = parseOptimizeRequest(goldenOptimizeRequest());
	assert.equal(request.trajectories.length, 1);

	const mismatched = goldenOptimizeRequest();
	mismatched.contract.allowedRegionId = "some-other-region";
	assert.throws(
		() => parseOptimizeRequest(mismatched),
		TrainingEngineParseError,
	);
});

test("parses a patch candidate and rejects out-of-region edits (ADR-0048)", () => {
	const base = {
		id: "candidate-1",
		engineId: "hobo.training-engine/built-in-opto@0.1.0",
		provenance: {
			trajectoryHashes: [TRAJECTORY_HASH],
			rubricRef: "rubric://support/classifier@1.0.0",
			contractRef: "contract://support/classification@1.0.0",
		},
		patch: {
			region: goldenRegion(),
			edits: [{ startOffset: 14, endOffset: 34, replacement: "return x;" }],
		},
	};
	// SAFETY: assertion required at this I/O or test boundary.
	const candidate = parseTrainingCandidate(base, goldenRegion() as never);
	assert.equal(candidate.body.case, "patch");

	const outOfRegion = {
		...base,
		patch: {
			region: goldenRegion(),
			edits: [{ startOffset: 81, endOffset: 90, replacement: "overwrite" }],
		},
	};
	assert.throws(
		// SAFETY: assertion required at this I/O or test boundary.
		() => parseTrainingCandidate(outOfRegion, goldenRegion() as never),
		TrainingEngineParseError,
	);
});

test("parses an artifact candidate (ADR-0125 apply-at-load form)", () => {
	const candidate = parseTrainingCandidate({
		id: "candidate-2",
		engineId: "hobo.training-engine/built-in-opto@0.1.0",
		provenance: {
			trajectoryHashes: [TRAJECTORY_HASH],
			rubricRef: "rubric://support/classifier@1.0.0",
			contractRef: "contract://support/classification@1.0.0",
		},
		artifact: goldenArtifact(),
	});
	assert.equal(candidate.body.case, "artifact");
	if (candidate.body.case === "artifact") {
		assert.equal(candidate.body.value.engineVersion, "22.0.9");
	}
});

test("parseTrainingArtifact validates the embedded program", () => {
	const artifact = parseTrainingArtifact(goldenArtifact());
	assert.equal(artifact.methodRef, "classifyTicket");

	assert.throws(
		() =>
			parseTrainingArtifact({ ...goldenArtifact(), programJson: "not json" }),
		TrainingEngineParseError,
	);
	assert.throws(
		() =>
			parseTrainingArtifact({
				...goldenArtifact(),
				programJson: JSON.stringify({ instructions: "" }),
			}),
		TrainingEngineParseError,
	);
});

test("hashTrajectory is canonical over the proto JSON form", () => {
	const first = hashTrajectory(parseTrajectory(goldenTrajectory()));
	const second = hashTrajectory(parseTrajectory(goldenTrajectory()));
	assert.equal(first, second);
	assert.match(first, /^sha256:[a-f0-9]{64}$/);
});
