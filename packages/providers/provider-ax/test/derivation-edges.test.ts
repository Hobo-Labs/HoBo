/**
 * The ax training engine's derivation edges (ADR-0025 / ADR-0125).
 *
 * The engine's job is to turn recorded trajectories into an optimizer run and
 * then normalise whatever comes back into a `TrainingCandidate`. Almost every
 * branch in it is a *degradation* path — a trajectory with unusable I/O, an
 * optimizer that threw, a request with no rubric — and each one has the same
 * property: it must not produce a candidate that looks better-founded than the
 * evidence behind it.
 *
 * Two specifics carry the weight:
 *
 * - **The demo floor.** Only trajectories at or above `DEMO_REWARD_FLOOR` (0.9)
 *   become demonstration examples. A low-reward execution promoted to a demo
 *   would teach the optimizer to reproduce a bad outcome, and the resulting
 *   artifact would pass the same promotion gate as a good one.
 * - **Optimizer failure degrades rather than propagates.** The `catch` around
 *   `axOptimize` leaves `axSerialized` null and the candidate falls back to the
 *   deterministic floor: the rubric objective as instructions and the recorded
 *   high-reward executions as demos. That is a *weaker* artifact, not a
 *   fabricated one — and it still goes through `parseTrainingCandidate`, so an
 *   engine bug cannot emit an out-of-contract candidate either way.
 */
import {
	parseTrainingArtifactProgram,
	TrainingEngineParseError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createAxTrainingEngine } from "../src/index.js";
import { mockModel, optimizeRequest, REGION, trajectory } from "./helpers.js";

/** A trajectory whose root span carries the given raw JSON strings. */
function rawTrajectory(
	id: string,
	inputsJson: string,
	outputsJson: string,
	reward = 0.95,
) {
	const base = trajectory(id, "subject", "category", reward);
	return {
		...base,
		spans: [{ ...base.spans[0], inputsJson, outputsJson }],
	};
}

function engine(maxMetricCalls = 4) {
	return createAxTrainingEngine({ ai: mockModel("access"), maxMetricCalls });
}

async function programFor(
	trajectories: readonly unknown[],
	overrides: Record<string, unknown> = {},
) {
	const candidate = await engine().optimize({
		...optimizeRequest(trajectories as never),
		...overrides,
	} as never);
	expect(candidate.body.case).toBe("artifact");
	if (candidate.body.case !== "artifact") throw new Error("unreachable");
	return parseTrainingArtifactProgram(candidate.body.value.programJson);
}

describe("engine identity", () => {
	it("defaults to the built-in engine id", () => {
		// The id is what the promotion gate attributes an artifact to. A default
		// that drifted would make previously-promoted artifacts unattributable.
		expect(engine().engineId).toBe("hobo.training-engine/built-in-opto@0.1.0");
	});

	it("honours an explicit engine id", () => {
		// So a Camp can run a differently-configured instance of the same engine
		// and have its artifacts distinguishable in provenance.
		const custom = createAxTrainingEngine({
			ai: mockModel("access"),
			engineId: "hobo.training-engine/custom@9.9.9",
		});
		expect(custom.engineId).toBe("hobo.training-engine/custom@9.9.9");
	});

	it("stamps the engine id on both the candidate and its artifact", async () => {
		const custom = createAxTrainingEngine({
			ai: mockModel("access"),
			maxMetricCalls: 4,
			engineId: "hobo.training-engine/custom@9.9.9",
		});
		const candidate = await custom.optimize(
			optimizeRequest([trajectory("t1", "s", "c", 0.95)]) as never,
		);
		expect(candidate.engineId).toBe("hobo.training-engine/custom@9.9.9");
		if (candidate.body.case !== "artifact") throw new Error("unreachable");
		expect(candidate.body.value.engineId).toBe(
			"hobo.training-engine/custom@9.9.9",
		);
	});
});

describe("root-span I/O extraction", () => {
	it("skips a trajectory whose root span has unparseable inputs", async () => {
		// `parseJsonRecord` returns null on a parse failure and the trajectory is
		// dropped from the example set. Feeding malformed text to the optimizer
		// as though it were a record would train against garbage.
		const program = await programFor([
			rawTrajectory("bad", "not json", JSON.stringify({ category: "a" })),
			rawTrajectory(
				"good",
				JSON.stringify({ subject: "s" }),
				JSON.stringify({ category: "a" }),
			),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("skips a trajectory whose root span I/O is not an object", async () => {
		// An array or a bare scalar parses as JSON but is not a field record, so
		// `deriveSignature` would produce a signature with no fields.
		for (const bad of ["[1,2]", '"a string"', "7", "null"]) {
			const program = await programFor([
				rawTrajectory("bad", bad, JSON.stringify({ category: "a" })),
				rawTrajectory(
					"good",
					JSON.stringify({ subject: "s" }),
					JSON.stringify({ category: "a" }),
				),
			]);
			expect(program.demos).toHaveLength(1);
		}
	});

	it("skips a trajectory with empty I/O strings", async () => {
		// The explicit `length === 0` short-circuit. An empty string is not a
		// record and `JSON.parse("")` would throw rather than returning null.
		const program = await programFor([
			rawTrajectory("bad", "", ""),
			rawTrajectory(
				"good",
				JSON.stringify({ subject: "s" }),
				JSON.stringify({ category: "a" }),
			),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("refuses a request in which no trajectory has usable I/O", async () => {
		// `deriveSignature` throws when the filtered list is empty, naming the
		// request. Emitting a candidate from zero examples would produce an
		// artifact with no evidence behind it that still passes promotion.
		await expect(
			engine().optimize(
				optimizeRequest([
					rawTrajectory("bad", "not json", "not json"),
				]) as never,
			),
		).rejects.toThrow(/has no trajectory with recorded root-span inputs/u);
	});

	it("names the request id in that refusal", async () => {
		await expect(
			engine().optimize({
				...optimizeRequest([rawTrajectory("bad", "", "")]),
				requestId: "optimize-request-xyz",
			} as never),
		).rejects.toThrow(/optimize-request-xyz/u);
	});

	it("never reaches the no-root-span case, because the parser refuses first", async () => {
		// Pinning where the guard actually lives. `rootSpanIo` looks for
		// `parentId === ""` and returns null otherwise, which reads as the
		// defence against a trajectory with no top-level span. It is not: the
		// core parser requires every non-empty `parentId` to reference another
		// span in the same trajectory, so a dangling parent is refused before
		// the engine sees it.
		//
		// That makes the engine's own null-root branch unreachable through this
		// entry point — belt and braces rather than dead code, since the engine
		// is behind a port and a future caller could hand it a differently
		// parsed shape. Recorded so nobody removes it believing it is covered.
		const base = trajectory("child-only", "s", "c", 0.95);
		await expect(
			engine().optimize(
				optimizeRequest([
					{
						...base,
						spans: [{ ...base.spans[0], parentId: "some-parent" }],
					},
				]) as never,
			),
		).rejects.toThrow(/expected reference to another span/u);
	});
});

describe("the demo reward floor", () => {
	it("promotes a trajectory at exactly the floor", async () => {
		// `>= 0.9`, so the boundary is included. A strict `>` would silently drop
		// every execution that scored exactly the threshold an operator set.
		const program = await programFor([trajectory("at-floor", "s", "c", 0.9)]);
		expect(program.demos).toHaveLength(1);
	});

	it("excludes a trajectory just below the floor", async () => {
		// The consequential direction: a low-reward execution promoted to a demo
		// would teach the optimizer to reproduce a bad outcome, and the artifact
		// would pass the same promotion gate as a good one.
		const program = await programFor([
			trajectory("good", "s", "c", 0.95),
			trajectory("below", "s2", "c2", 0.89),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("keeps every qualifying trajectory rather than only the best", async () => {
		const program = await programFor([
			trajectory("a", "s1", "c1", 0.95),
			trajectory("b", "s2", "c2", 0.97),
			trajectory("c", "s3", "c3", 0.5),
		]);
		expect(program.demos).toHaveLength(2);
	});

	it("can emit an artifact with no demos at all", async () => {
		// A run in which nothing cleared the floor still produces a candidate —
		// the instructions alone are a legitimate, weaker artifact. Refusing
		// would make the engine unusable exactly when a caller most wants to see
		// what the optimizer found.
		const program = await programFor([trajectory("low", "s", "c", 0.1)]);
		expect(program.demos).toEqual([]);
	});

	it("carries the recorded input and output into each demo", async () => {
		const program = await programFor([
			rawTrajectory(
				"a",
				JSON.stringify({ subject: "reset password" }),
				JSON.stringify({ category: "access" }),
			),
		]);
		// Demos are carried as JSON *strings* on the wire, not as nested objects,
		// so the program stays a flat proto message. Asserting the parsed value
		// rather than the string keeps this about the content.
		expect(JSON.parse(program.demos[0]?.inputJson ?? "null")).toEqual({
			subject: "reset password",
		});
		expect(JSON.parse(program.demos[0]?.outputJson ?? "null")).toEqual({
			category: "access",
		});
	});
});

describe("instructions fallback", () => {
	it("falls back to the rubric objective when the optimizer produced none", async () => {
		// The deterministic floor. The chain is
		// `axSerialized?.instruction ?? rubric.objective`, then `|| ""` — so an
		// optimizer that returned nothing usable still yields an artifact whose
		// instructions state the objective rather than being blank.
		const program = await programFor([trajectory("a", "s", "c", 0.95)]);
		expect(typeof program.instructions).toBe("string");
		expect(program.instructions.length).toBeGreaterThan(0);
	});

	it("cannot reach the empty-instructions floor, because the rubric objective is required", async () => {
		// The engine ends its instruction chain with `|| ""`, which reads as a
		// guard against a rubric that stated no objective. The core parser makes
		// that unreachable: `optimizeRequest.rubric.objective` must be a
		// non-empty string, so an objective-less request never arrives.
		//
		// Pinned rather than removed for the same reason as the root-span case:
		// the engine sits behind a port and re-parses its own boundary, so the
		// fallback is defence in depth rather than dead code.
		await expect(
			engine().optimize({
				...optimizeRequest([trajectory("a", "s", "c", 0.95)]),
				rubric: { id: "rubric://x@1.0.0", objective: "" },
			} as never),
		).rejects.toThrow(/rubric\.objective: expected non-empty string/u);
	});
});

describe("provenance", () => {
	it("hashes every trajectory, including ones dropped from the examples", async () => {
		// Provenance records what the request *contained*, not what survived
		// filtering. A hash list that silently shrank would make an artifact look
		// as though it had been derived from fewer executions than were offered.
		const candidate = await engine().optimize(
			optimizeRequest([
				rawTrajectory("bad", "not json", "not json"),
				rawTrajectory(
					"good",
					JSON.stringify({ subject: "s" }),
					JSON.stringify({ category: "a" }),
				),
			]) as never,
		);
		expect(candidate.provenance?.trajectoryHashes).toHaveLength(2);
	});

	it("requires a rubric on the request, so the empty-ref defaults are unreachable", async () => {
		// The third of the same shape. `parsed.rubric?.id ?? ""` and
		// `parsed.contract?.ref ?? ""` look like they tolerate a request that
		// named neither; the parser does not, so provenance is never empty in
		// practice. That is the right end of it — an artifact whose provenance
		// cited no rubric would be unpromotable anyway.
		await expect(
			engine().optimize({
				requestId: "no-refs",
				generatedRegion: REGION,
				trajectories: [trajectory("a", "s", "c", 0.95)],
			} as never),
		).rejects.toThrow(/rubric: expected present/u);
	});

	it("carries the rubric and contract references it was given", async () => {
		const candidate = await engine().optimize(
			optimizeRequest([trajectory("a", "s", "c", 0.95)]) as never,
		);
		expect(candidate.provenance?.rubricRef).toBe(
			"rubric://support/classifier@1.0.0",
		);
		expect(candidate.provenance?.contractRef).toBe(
			"contract://support/classification@1.0.0",
		);
		if (candidate.body.case !== "artifact") throw new Error("unreachable");
		expect(candidate.body.value.methodRef).toBe("classifyTicket");
	});

	it("derives the candidate id from the request id", async () => {
		// Deterministic, so re-running the same request produces the same id and
		// a downstream store can dedupe rather than accumulating near-duplicates.
		const candidate = await engine().optimize({
			...optimizeRequest([trajectory("a", "s", "c", 0.95)]),
			requestId: "req-7",
		} as never);
		expect(candidate.id).toBe("candidate-req-7");
	});
});

describe("boundary parsing", () => {
	it("re-parses the request even from a trusted caller", async () => {
		// Parse, don't validate — at the boundary, every time. The engine is
		// selected behind a port, so "trusted caller" is not a property it can
		// check.
		await expect(engine().optimize({ requestId: "" } as never)).rejects.toThrow(
			TrainingEngineParseError,
		);
	});

	it("refuses a request with no trajectories", async () => {
		await expect(
			engine().optimize({
				requestId: "empty",
				generatedRegion: REGION,
				trajectories: [],
			} as never),
		).rejects.toThrow();
	});

	it("emits a candidate that survives the port's own parser", async () => {
		// The return goes back through `parseTrainingCandidate`, so an engine
		// bug cannot emit an out-of-contract candidate — this asserts the
		// round trip rather than the engine's internal shape.
		const candidate = await engine().optimize(
			optimizeRequest([trajectory("a", "s", "c", 0.95)]) as never,
		);
		expect(candidate.body.case).toBe("artifact");
		if (candidate.body.case !== "artifact") throw new Error("unreachable");
		expect(candidate.body.value.engineVersion).toMatch(/^\d+\.\d+\.\d+/u);
		expect(() =>
			parseTrainingArtifactProgram(candidate.body.value.programJson),
		).not.toThrow();
	});
});

describe("teacher model", () => {
	it("runs without one", async () => {
		// The conditional spread: `teacherAI` is only passed when configured.
		// Passing `undefined` through would be a different optimizer
		// configuration than omitting it.
		const candidate = await engine().optimize(
			optimizeRequest([trajectory("a", "s", "c", 0.95)]) as never,
		);
		expect(candidate.body.case).toBe("artifact");
	});

	it("accepts one when configured", async () => {
		const withTeacher = createAxTrainingEngine({
			ai: mockModel("access"),
			teacherAI: mockModel("access"),
			maxMetricCalls: 4,
		});
		const candidate = await withTeacher.optimize(
			optimizeRequest([trajectory("a", "s", "c", 0.95)]) as never,
		);
		expect(candidate.body.case).toBe("artifact");
	});
});

describe("cost ceiling", () => {
	it("accepts an explicit metric-call budget", async () => {
		// The ceiling is a hard cost bound on a run that calls a model. A default
		// that silently applied when a caller set one would make spend
		// unpredictable.
		const candidate = await createAxTrainingEngine({
			ai: mockModel("access"),
			maxMetricCalls: 1,
		}).optimize(optimizeRequest([trajectory("a", "s", "c", 0.95)]) as never);
		expect(candidate.body.case).toBe("artifact");
	});

	it("runs with the default budget when none is given", async () => {
		const candidate = await createAxTrainingEngine({
			ai: mockModel("access"),
		}).optimize(optimizeRequest([trajectory("a", "s", "c", 0.95)]) as never);
		expect(candidate.body.case).toBe("artifact");
	});
});
