import type { TrainingEnginePort } from "@hobo/core";
import { parseOptimizeRequest, parseTrainingArtifactProgram } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	BUILTIN_TRAINING_ENGINE_ID,
	BUILTIN_TRAINING_ENGINE_VERSION,
	createBuiltinTrainingEngine,
	createSeededPrng,
	OPENINFERENCE_SPAN_KIND_ATTRIBUTE,
	parseOptimizerConfig,
	TrainingOptimizerParseError,
} from "../src/index.js";
import { isJsonString } from "../src/json.js";

const REGION = {
	regionId: "region-1",
	artifactRef: "app/src/summarize.ts",
	startOffset: 10,
	endOffset: 90,
	owner: "training-engine",
};

function trajectoryJson(index: number, reward: number) {
	return {
		id: `traj-${index}`,
		traceparent: `00-0123456789abcdef0123456789abcde${index}-0123456789abcde${index}-01`,
		run: {
			id: `run-${index}`,
			tenantId: "tenant-1",
			bindle: "bindle://app",
			agent: { id: "agent-1", principalRef: "principal://agent-1" },
		},
		subject: {
			method: "summarize",
			contractRef: "contracts/summarize",
			generatedRegion: REGION,
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
				inputsJson: JSON.stringify({ ticket: `ticket ${index}` }),
				outputsJson: JSON.stringify({ summary: `summary ${index}` }),
			},
		],
		payloads: {},
		reward: {
			source: "live-eval",
			rubricRef: "rubric-1",
			score: reward,
			observedAt: "2026-08-01T00:00:02Z",
		},
	};
}

function fixtureRequest() {
	return parseOptimizeRequest({
		requestId: "req-1",
		generatedRegion: REGION,
		trajectories: [
			trajectoryJson(0, 0.2),
			trajectoryJson(1, 0.9),
			trajectoryJson(2, 0.5),
			trajectoryJson(3, 0.7),
		],
		rubric: { id: "rubric-1", objective: "Summarize the ticket faithfully." },
		contract: {
			ref: "contracts/summarize",
			method: "summarize",
			allowedRegionId: "region-1",
		},
	});
}

const CONFIG = { seed: 7, maxIterations: 6, demosPerCandidate: 2 };

describe("seeded prng", () => {
	it("replays the identical stream for the same seed", () => {
		const a = createSeededPrng(42);
		const b = createSeededPrng(42);
		const streamA = Array.from({ length: 16 }, () => a.next());
		const streamB = Array.from({ length: 16 }, () => b.next());
		expect(streamA).toEqual(streamB);
		expect(new Set(streamA).size).toBeGreaterThan(1);
	});

	it("diverges for a different seed", () => {
		const a = Array.from({ length: 8 }, () => createSeededPrng(1).next());
		const b = Array.from({ length: 8 }, () => createSeededPrng(2).next());
		expect(a).not.toEqual(b);
	});
});

describe("deterministic convergence", () => {
	it("same seed produces the identical trajectory and winner", async () => {
		const first = createBuiltinTrainingEngine(CONFIG);
		const second = createBuiltinTrainingEngine(CONFIG);
		const request = fixtureRequest();

		const winnerA = await first.optimize(request);
		const winnerB = await second.optimize(request);
		const spansA = first.drainTraceSpans();
		const spansB = second.drainTraceSpans();

		expect(spansA).toEqual(spansB);
		expect(winnerA.id).toEqual(winnerB.id);
		expect(winnerA.provenance).toEqual(winnerB.provenance);
		expect(winnerA.body).toEqual(winnerB.body);
	});

	it("a different seed produces a different proposal trajectory", async () => {
		const first = createBuiltinTrainingEngine({ ...CONFIG, seed: 7 });
		const second = createBuiltinTrainingEngine({ ...CONFIG, seed: 8 });
		const request = fixtureRequest();

		await first.optimize(request);
		await second.optimize(request);

		expect(first.drainTraceSpans()).not.toEqual(second.drainTraceSpans());
	});

	it("emits a well-formed artifact candidate for the winner", async () => {
		const engine = createBuiltinTrainingEngine(CONFIG);
		const request = fixtureRequest();
		const candidate = await engine.optimize(request);

		expect(candidate.engineId).toBe(BUILTIN_TRAINING_ENGINE_ID);
		expect(candidate.provenance?.trajectoryHashes).toHaveLength(4);
		for (const hash of candidate.provenance?.trajectoryHashes ?? []) {
			expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
		}
		expect(candidate.provenance?.rubricRef).toBe("rubric-1");
		expect(candidate.provenance?.contractRef).toBe("contracts/summarize");

		expect(candidate.body.case).toBe("artifact");
		if (candidate.body.case !== "artifact") return;
		const artifact = candidate.body.value;
		expect(artifact.engineVersion).toBe(BUILTIN_TRAINING_ENGINE_VERSION);
		expect(artifact.methodRef).toBe("contracts/summarize#summarize");
		const program = parseTrainingArtifactProgram(artifact.programJson);
		expect(program.instructions).toContain("Summarize the ticket faithfully.");
		expect(program.demos).toHaveLength(2);
	});
});

describe("keep-best invariant", () => {
	it("the best score never regresses across iterations", async () => {
		const engine = createBuiltinTrainingEngine(CONFIG);
		const candidate = await engine.optimize(fixtureRequest());
		const spans = engine.drainTraceSpans();

		let best = Number.NEGATIVE_INFINITY;
		for (const span of spans) {
			if (span.decision === "kept") {
				expect(span.score).toBeGreaterThan(best);
				best = span.score;
			} else {
				expect(span.score).toBeLessThanOrEqual(best);
			}
		}

		expect(candidate.body.case).toBe("artifact");
		if (candidate.body.case !== "artifact") return;
		const program = parseTrainingArtifactProgram(
			candidate.body.value.programJson,
		);
		// SAFETY: `const payload = JSON.parse(program.enginePayloadJson) as {` is required at this I/O or test boundary.
		const payload = JSON.parse(program.enginePayloadJson) as {
			winnerScore: number;
		};
		expect(payload.winnerScore).toBe(best);
		expect(payload.winnerScore).toBe(
			Math.max(...spans.map((span) => span.score)),
		);
	});
});

describe("trace capture", () => {
	it("records one OpenInference-aligned span per step and drains empty", async () => {
		const engine = createBuiltinTrainingEngine(CONFIG);
		await engine.optimize(fixtureRequest());
		const spans = engine.drainTraceSpans();

		expect(spans).toHaveLength(CONFIG.maxIterations);
		for (const [index, span] of spans.entries()) {
			expect(span.id).toBe(`opto-step-${index}`);
			expect(span.name).toBe(`opto.step.${index}`);
			expect(span.kind).toBe("CHAIN");
			expect(span.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(span.score).toBeGreaterThanOrEqual(0);
			expect(span.score).toBeLessThanOrEqual(1);
			expect(["kept", "rejected"]).toContain(span.decision);
			expect(span.attributes[OPENINFERENCE_SPAN_KIND_ATTRIBUTE]).toBe("CHAIN");
			expect(span.attributes["optimizer.iteration"]).toBe(String(index));
			expect(span.attributes["optimizer.input_digest"]).toBe(span.inputDigest);
			expect(span.attributes["optimizer.decision"]).toBe(span.decision);
		}

		expect(engine.drainTraceSpans()).toEqual([]);
	});
});

describe("port conformance", () => {
	it("satisfies core's TrainingEnginePort", async () => {
		const engine = createBuiltinTrainingEngine(CONFIG);
		// Type-level: BuiltinTrainingEngine extends TrainingEnginePort, and the
		// assignment below only compiles if the shapes agree.
		const port: TrainingEnginePort = engine;

		expect(isJsonString(port.engineId)).toBe(true);
		expect(port.engineId).toBe(BUILTIN_TRAINING_ENGINE_ID);
		expect(port.optimize instanceof Function).toBe(true);
		expect(port.optimize.length).toBe(1);
		const candidate = await port.optimize(fixtureRequest());
		expect(candidate.id).toMatch(/^opto-[a-f0-9]{16}$/);
	});
});

describe("malformed config typed rejections", () => {
	const cases: readonly [string, unknown][] = [
		["non-object", 42],
		["null", null],
		["array", [7]],
		["missing seed", { maxIterations: 3 }],
		["fractional seed", { seed: 1.5 }],
		["negative seed", { seed: -1 }],
		["seed above 32 bits", { seed: 2 ** 32 }],
		["zero iterations", { seed: 7, maxIterations: 0 }],
		["fractional iterations", { seed: 7, maxIterations: 2.5 }],
		["zero demos", { seed: 7, demosPerCandidate: 0 }],
		["empty engineId", { seed: 7, engineId: "" }],
	];

	for (const [label, value] of cases) {
		it(`rejects ${label}`, () => {
			expect(() => parseOptimizerConfig(value)).toThrow(
				TrainingOptimizerParseError,
			);
		});
	}

	it("carries the typed error code and path", () => {
		try {
			parseOptimizerConfig({ seed: -1 });
			expect.unreachable("parse must throw");
		} catch (error) {
			expect(error).toBeInstanceOf(TrainingOptimizerParseError);
			// SAFETY: `const parseError = error as TrainingOptimizerParseError;` is required at this I/O or test boundary.
			const parseError = error as TrainingOptimizerParseError;
			expect(parseError.name).toBe("TrainingOptimizerParseError");
			expect(parseError.code).toBe("HOBO_TRAINING_OPTIMIZER_PARSE");
			expect(parseError.path).toBe("config.seed");
		}
	});

	it("applies defaults for omitted optional fields", () => {
		const parsed = parseOptimizerConfig({ seed: 7 });
		expect(parsed.engineId).toBe(BUILTIN_TRAINING_ENGINE_ID);
		expect(parsed.maxIterations).toBe(8);
		expect(parsed.demosPerCandidate).toBe(2);
	});

	it("rejects a request stripped of its trajectories at the port boundary", async () => {
		const engine = createBuiltinTrainingEngine(CONFIG);
		const parsed = fixtureRequest();
		// SAFETY: `const hollow = Object.create(` is required at this I/O or test boundary.
		const hollow = Object.create(
			// SAFETY: `Object.getPrototypeOf(parsed) as object,` is required at this I/O or test boundary.
			Object.getPrototypeOf(parsed) as object,
		) as typeof parsed;
		Object.assign(hollow, parsed, { trajectories: [] });
		await expect(engine.optimize(hollow)).rejects.toThrow(
			TrainingOptimizerParseError,
		);
	});
});
