import { parseOptimizeRequest, parseTrainingArtifactProgram } from "@hobo/core";
import { expect, it } from "vitest";
import { createBuiltinTrainingEngine } from "../src/index.js";

const region = {
	regionId: "region-1",
	artifactRef: "app/src/run.ts",
	startOffset: 0,
	endOffset: 10,
	owner: "training-engine",
};
function requestFor(scores: readonly number[]) {
	return parseOptimizeRequest({
		requestId: "req-1",
		generatedRegion: region,
		trajectories: scores.map((score, index) => ({
			id: `traj-${index}`,
			traceparent: `00-0123456789abcdef0123456789abcde${index}-0123456789abcde${index}-01`,
			run: {
				id: `run-${index}`,
				tenantId: "tenant-1",
				bindle: "bindle://app",
				agent: { id: "agent-1", principalRef: "principal://agent-1" },
			},
			subject: {
				method: "run",
				contractRef: "contracts/run",
				generatedRegion: region,
			},
			spans: [
				{
					id: `span-${index}`,
					parentId: "",
					kind: "OPEN_INFERENCE_SPAN_KIND_LLM",
					name: "llm.call",
					startTime: "2026-08-01T00:00:00Z",
					endTime: "2026-08-01T00:00:01Z",
					attributes: {},
					inputsJson: JSON.stringify({ input: index }),
					outputsJson: JSON.stringify({ output: index }),
				},
			],
			payloads: {},
			reward: {
				source: "live-eval",
				rubricRef: "rubric-1",
				score,
				observedAt: "2026-08-01T00:00:02Z",
			},
		})),
		rubric: { id: "rubric-1", objective: "Run the task." },
		contract: {
			ref: "contracts/run",
			method: "run",
			allowedRegionId: "region-1",
		},
	});
}

it("rejects invalid reward scores before recording trace spans", async () => {
	for (const invalid of [Number.NaN, Infinity, -Infinity, -0.1, 1.1]) {
		const request = structuredClone(requestFor([0.2, 0.8]));
		const reward = request.trajectories[1]?.reward;
		if (!reward) throw new Error("missing test reward");
		reward.score = invalid;
		const engine = createBuiltinTrainingEngine({ seed: 7, maxIterations: 4 });
		await expect(engine.optimize(request)).rejects.toMatchObject({
			name: "TrainingOptimizerParseError",
			path: "request.trajectories.1.reward.score",
		});
		expect(engine.drainTraceSpans()).toEqual([]);
	}
});

it("retains the first candidate when all proposal scores tie", async () => {
	const engine = createBuiltinTrainingEngine({
		seed: 7,
		maxIterations: 6,
		demosPerCandidate: 2,
	});
	const candidate = await engine.optimize(requestFor([0.5, 0.5, 0.5, 0.5]));
	const spans = engine.drainTraceSpans();
	expect(spans.map((span) => span.decision)).toEqual([
		"kept",
		"rejected",
		"rejected",
		"rejected",
		"rejected",
		"rejected",
	]);
	if (candidate.body.case !== "artifact") throw new Error("missing artifact");
	const program = parseTrainingArtifactProgram(
		candidate.body.value.programJson,
	);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture parses the payload written by the optimizer under test.
	const payload = JSON.parse(program.enginePayloadJson) as {
		winnerDigest: string;
		winnerScore: number;
	};
	expect(payload.winnerDigest).toBe(spans[0]?.inputDigest);
	expect(payload.winnerScore).toBe(0.5);
});

it("keeps the first highest-scoring candidate for generated runs", async () => {
	let seed = 0x3b43e891;
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	for (let trial = 0; trial < 80; trial++) {
		const scores = Array.from({ length: 4 }, () => (next() % 11) / 10);
		const engine = createBuiltinTrainingEngine({
			seed: next(),
			maxIterations: 6,
			demosPerCandidate: 1 + (next() % 4),
		});
		const candidate = await engine.optimize(requestFor(scores));
		const spans = engine.drainTraceSpans();
		let best = -1;
		let firstBestDigest = "";
		for (const span of spans) {
			if (span.score > best) {
				expect(span.decision).toBe("kept");
				best = span.score;
				firstBestDigest = span.inputDigest;
			} else expect(span.decision).toBe("rejected");
		}
		if (candidate.body.case !== "artifact") throw new Error("missing artifact");
		const program = parseTrainingArtifactProgram(
			candidate.body.value.programJson,
		);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture parses the payload written by the optimizer under test.
		const payload = JSON.parse(program.enginePayloadJson) as {
			winnerDigest: string;
			winnerScore: number;
		};
		expect(payload.winnerScore).toBe(best);
		expect(payload.winnerDigest).toBe(firstBestDigest);
	}
});

it("keeps previously queued traces unchanged when a later run fails", async () => {
	const config = { seed: 7, maxIterations: 4, demosPerCandidate: 2 };
	const expectedEngine = createBuiltinTrainingEngine(config);
	await expectedEngine.optimize(requestFor([0.2, 0.8]));
	const expected = expectedEngine.drainTraceSpans();

	const engine = createBuiltinTrainingEngine(config);
	await engine.optimize(requestFor([0.2, 0.8]));
	const invalid = structuredClone(requestFor([0.2, 0.8]));
	if (!invalid.rubric) throw new Error("missing test rubric");
	invalid.rubric.id = "";
	await expect(engine.optimize(invalid)).rejects.toThrow();
	expect(engine.drainTraceSpans()).toEqual(expected);
	expect(engine.drainTraceSpans()).toEqual([]);
});

it("appends one complete trace batch for each successful run", async () => {
	const engine = createBuiltinTrainingEngine({
		seed: 7,
		maxIterations: 4,
		demosPerCandidate: 2,
	});
	await engine.optimize(requestFor([0.2, 0.8]));
	await engine.optimize(requestFor([0.2, 0.8]));
	const spans = engine.drainTraceSpans();
	expect(spans).toHaveLength(8);
	expect(spans.slice(0, 4)).toEqual(spans.slice(4));
	expect(engine.drainTraceSpans()).toEqual([]);
});
