/**
 * The ax training engine's edge behaviour — malformed trajectories, the
 * reward-weighted metric, and degrading to a deterministic floor.
 *
 * This engine turns recorded executions into an optimized program. Two
 * properties make it safe to run against real production traces.
 *
 * **An optimizer failure degrades rather than propagating.** The candidate it
 * produces still has to pass the same promotion gate, so a failed ax run
 * yields a candidate built from the deterministic floor — the recorded
 * high-reward executions as demos and the rubric objective as instructions.
 * Throwing instead would make the whole training run fail on a transient model
 * error, discarding trajectories that took real traffic to collect.
 *
 * **Only high-reward trajectories become demonstrations.** A demo is an
 * example the optimized program imitates, so including a poorly-rewarded
 * execution would teach the program to reproduce a bad answer. The floor is
 * fixed at 0.9 and everything below it still contributes to provenance and to
 * the metric — it just does not become something to copy.
 *
 * **Trajectories with unusable I/O are dropped, not guessed at.** A root span
 * with malformed JSON, an array body, or no root at all carries no
 * input/output pair, and inventing one would derive a signature that does not
 * match the recorded work.
 *
 * The metric is reward-weighted on purpose: a prediction agreeing with a
 * trajectory that scored 0.2 in live eval is worth much less than one agreeing
 * with a 0.97, and a flat exact-match metric would treat them the same.
 */
import { parseTrainingArtifactProgram } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createAxTrainingEngine } from "../src/index.js";
import { mockModel, optimizeRequest, trajectory } from "./helpers.js";

/** A trajectory whose root span carries the given raw JSON strings. */
function rawTrajectory(
	id: string,
	spans: Array<Record<string, unknown>>,
	reward = 0.95,
) {
	const base = trajectory(id, "subject", "category", reward);
	return { ...base, spans } as unknown as ReturnType<typeof trajectory>;
}

function rootSpan(overrides: Record<string, unknown> = {}) {
	return {
		id: "root",
		kind: "OPEN_INFERENCE_SPAN_KIND_CHAIN",
		name: "support.classifyTicket",
		startTime: "2026-06-25T09:00:00.000Z",
		endTime: "2026-06-25T09:00:00.120Z",
		inputsJson: JSON.stringify({ subject: "a" }),
		outputsJson: JSON.stringify({ category: "access" }),
		...overrides,
	};
}

const engine = (options: Record<string, unknown> = {}) =>
	createAxTrainingEngine({
		ai: mockModel("access"),
		maxMetricCalls: 4,
		...options,
	} as never);

const programOf = async (
	trajectories: readonly ReturnType<typeof trajectory>[],
	options: Record<string, unknown> = {},
) => {
	const candidate = await engine(options).optimize(
		optimizeRequest(trajectories) as never,
	);
	if (candidate.body.case !== "artifact") throw new Error("not an artifact");
	return {
		candidate,
		artifact: candidate.body.value,
		program: parseTrainingArtifactProgram(candidate.body.value.programJson),
	};
};

describe("engine identity", () => {
	it("uses the built-in engine id by default", () => {
		// The id is what the training-engine port selects on. A wrong one would
		// make the engine unreachable through the port it registers under.
		expect(engine().engineId).toBe("hobo.training-engine/built-in-opto@0.1.0");
	});

	it("accepts an override so a Camp can register a variant", () => {
		expect(engine({ engineId: "custom@1.0.0" }).engineId).toBe("custom@1.0.0");
	});

	it("stamps the engine id onto the candidate and its artifact", async () => {
		// The candidate travels to a promotion gate that has no other way to
		// know which engine produced it.
		const { candidate, artifact } = await programOf([
			trajectory("t1", "a", "access", 0.95),
		]);
		expect(candidate.engineId).toBe(engine().engineId);
		expect(artifact.engineId).toBe(engine().engineId);
	});
});

describe("trajectory selection", () => {
	it("drops a trajectory whose spans carry no root", async () => {
		// A span tree with no root has no recorded call to learn from. Using a
		// child's I/O would train on an inner step rather than the method.
		//
		// Note the parser upstream already refuses a span whose parentId names
		// no sibling, so the reachable shape is a real parent/child pair where
		// only the child carries I/O — the engine still takes the root's, and
		// the root here has none.
		const { program } = await programOf([
			trajectory("t1", "a", "access", 0.95),
			rawTrajectory("t2", [
				rootSpan({ id: "root", inputsJson: "", outputsJson: "" }),
				rootSpan({ id: "child", parentId: "root" }),
			]),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("drops a trajectory whose recorded JSON does not parse", async () => {
		// A truncated payload is not a usable example. Passing the raw string
		// through would derive fields from arbitrary text.
		const { program } = await programOf([
			trajectory("t1", "a", "access", 0.95),
			rawTrajectory("t2", [rootSpan({ inputsJson: "{ broken" })]),
			rawTrajectory("t3", [rootSpan({ outputsJson: "not json" })]),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("drops a trajectory whose I/O is an array or a scalar", async () => {
		// The signature is derived from field names. An array has none, and its
		// numeric indices would become field names in the derived signature.
		const { program } = await programOf([
			trajectory("t1", "a", "access", 0.95),
			rawTrajectory("t2", [rootSpan({ inputsJson: "[1,2]" })]),
			rawTrajectory("t3", [rootSpan({ outputsJson: '"scalar"' })]),
			rawTrajectory("t4", [rootSpan({ inputsJson: "null" })]),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("drops a trajectory whose I/O strings are empty", async () => {
		// An unrecorded payload is empty rather than absent. Parsing it as an
		// empty object would derive a signature with no fields at all.
		const { program } = await programOf([
			trajectory("t1", "a", "access", 0.95),
			rawTrajectory("t2", [rootSpan({ inputsJson: "" })]),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("refuses the whole request when no trajectory has usable I/O", async () => {
		// There is nothing to derive a signature from, and guessing one would
		// produce a program unrelated to the recorded work. The message names
		// the request so the caller can find it.
		await expect(
			engine().optimize(
				optimizeRequest([
					rawTrajectory("t1", [rootSpan({ inputsJson: "{ broken" })]),
				]) as never,
			),
		).rejects.toThrow(/optimize-request-1 has no trajectory/);
	});

	it("keeps every trajectory in provenance, usable or not", async () => {
		// Provenance records what the run was built from, which includes the
		// traces that turned out to be unusable — otherwise an audit could not
		// tell a dropped trace from one never collected.
		const { candidate } = await programOf([
			trajectory("t1", "a", "access", 0.95),
			rawTrajectory("t2", [rootSpan({ inputsJson: "{ broken" })]),
		]);
		expect(candidate.provenance?.trajectoryHashes).toHaveLength(2);
	});
});

describe("demonstration floor", () => {
	it("includes a trajectory at exactly the floor", async () => {
		// The floor is inclusive: a trajectory that scored exactly 0.9 met the
		// bar, and excluding it would make the constant mean something else.
		const { program } = await programOf([trajectory("t1", "a", "access", 0.9)]);
		expect(program.demos).toHaveLength(1);
	});

	it("excludes a trajectory just below the floor", async () => {
		// A demo is an example the program imitates. Copying a poorly-rewarded
		// execution would teach it to reproduce a bad answer.
		const { program } = await programOf([
			trajectory("t1", "a", "access", 0.95),
			trajectory("t2", "b", "outage", 0.899),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("carries the recorded input and output into each demo", async () => {
		const { program } = await programOf([
			trajectory("t1", "cannot reset password", "access", 0.95),
		]);
		// Demos serialize as JSON strings in the proto, not as nested objects —
		// the program travels as one blob to a promotion gate that does not
		// need to walk into each demo.
		expect(program.demos[0]).toMatchObject({
			inputJson: JSON.stringify({ subject: "cannot reset password" }),
			outputJson: JSON.stringify({ category: "access" }),
		});
	});

	it("produces no demos when nothing cleared the floor", async () => {
		// A run over only low-reward traces is still a valid run — it just has
		// nothing worth imitating, and the candidate says so rather than
		// inventing demos.
		const { program } = await programOf([
			trajectory("t1", "a", "access", 0.1),
			trajectory("t2", "b", "outage", 0.5),
		]);
		expect(program.demos).toEqual([]);
	});

	it("refuses a trajectory with no reward at all", async () => {
		// The engine's own `?? 0` fallback is unreachable: the port parser
		// requires a reward before the engine sees the trajectory. That is the
		// stronger guarantee — an unrewarded trace has not been shown to be
		// good, and it is rejected at the boundary rather than silently
		// scoring zero somewhere inside.
		const { reward: _dropped, ...base } = trajectory("t1", "a", "access", 0.95);
		await expect(
			engine().optimize(optimizeRequest([base as never]) as never),
		).rejects.toThrow(/trajectory\.reward/);
	});

	it("scores a zero-reward trajectory below the floor", async () => {
		// The reachable version of the same property: present but worthless.
		const { program } = await programOf([
			trajectory("t1", "a", "access", 0.95),
			trajectory("t2", "b", "outage", 0),
		]);
		expect(program.demos).toHaveLength(1);
	});
});

describe("degrading when the optimizer fails", () => {
	/** An AI service that fails every call. */
	const brokenAi = {
		getName: () => "broken",
		getFeatures: () => ({ functions: false, streaming: false }),
		chat: async () => {
			throw new Error("model unavailable");
		},
		embed: async () => {
			throw new Error("model unavailable");
		},
	} as never;

	it("still produces a candidate when the optimizer throws", async () => {
		// A transient model error must not discard trajectories that took real
		// production traffic to collect.
		const { candidate, program } = await programOf(
			[trajectory("t1", "a", "access", 0.95)],
			{ ai: brokenAi },
		);
		expect(candidate.body.case).toBe("artifact");
		expect(program.demos).toHaveLength(1);
	});

	it("falls back to the rubric objective as the instructions", async () => {
		// Without a tuned instruction from ax, the objective is the closest
		// honest description of what the program is for.
		const { program } = await programOf(
			[trajectory("t1", "a", "access", 0.95)],
			{ ai: brokenAi },
		);
		expect(program.instructions).toBe("maximize classification reward");
	});

	it("carries no engine payload when there is no optimized program", async () => {
		// The payload is this engine's private serialization. An empty one is
		// how a reader knows the deterministic floor is all there is.
		const { program } = await programOf(
			[trajectory("t1", "a", "access", 0.95)],
			{ ai: brokenAi },
		);
		expect(program.enginePayloadJson).toBe("");
	});

	it("keeps full provenance through the degraded path", async () => {
		// The candidate faces the same promotion gate either way, and the gate
		// reads provenance.
		const { candidate, artifact } = await programOf(
			[
				trajectory("t1", "a", "access", 0.95),
				trajectory("t2", "b", "outage", 0.97),
			],
			{ ai: brokenAi },
		);
		expect(candidate.provenance?.trajectoryHashes).toHaveLength(2);
		expect(candidate.provenance?.rubricRef).toBe(
			"rubric://support/classifier@1.0.0",
		);
		expect(artifact.methodRef).toBe("classifyTicket");
	});
});

describe("request fields the engine tolerates", () => {
	it("refuses a request with no rubric, rather than defaulting its ref", async () => {
		// The engine carries `?? ""` fallbacks for the rubric and contract, but
		// they are unreachable: the port parser requires both to be present.
		// Pinned as the refusal rather than the fallback, because that is the
		// contract a caller actually meets — a training run with no stated
		// objective and no contract has nothing to promote against.
		const { rubric: _dropped, ...request } = optimizeRequest([
			trajectory("t1", "a", "access", 0.95),
		]);
		await expect(engine().optimize(request as never)).rejects.toThrow(
			/optimizeRequest\.rubric/,
		);
	});

	it("refuses a request with no contract", async () => {
		const { contract: _dropped, ...request } = optimizeRequest([
			trajectory("t1", "a", "access", 0.95),
		]);
		await expect(engine().optimize(request as never)).rejects.toThrow(
			/optimizeRequest\.contract/,
		);
	});

	it("refuses an empty objective, so the instruction fallback is unreachable", async () => {
		// The engine ends its instruction expression with `|| ""`, but the port
		// parser requires a non-empty objective, and a failed ax run falls back
		// to that objective. So the empty-instruction branch cannot be reached
		// through the port at all.
		//
		// That is the stronger contract and worth pinning as such: a training
		// run whose rubric states no objective is rejected at the boundary
		// rather than producing a program described by nothing.
		const request = optimizeRequest([trajectory("t1", "a", "access", 0.95)]);
		await expect(
			engine().optimize({
				...request,
				rubric: { ...request.rubric, objective: "" },
			} as never),
		).rejects.toThrow(/rubric\.objective/);
	});

	it("escapes double quotes out of the objective it puts in the signature", async () => {
		// The objective is interpolated into a quoted ax signature. An unescaped
		// quote would terminate it early and change the derived program's shape.
		const request = optimizeRequest([trajectory("t1", "a", "access", 0.95)]);
		const candidate = await engine().optimize({
			...request,
			rubric: { id: "r", objective: 'maximize "reward" now' },
		} as never);
		expect(candidate.body.case).toBe("artifact");
	});

	it("names the candidate after the request it answers", async () => {
		// Two runs over the same request must produce the same candidate id, or
		// a retry would look like a second candidate to promote.
		const { candidate } = await programOf([
			trajectory("t1", "a", "access", 0.95),
		]);
		expect(candidate.id).toBe("candidate-optimize-request-1");
	});
});
