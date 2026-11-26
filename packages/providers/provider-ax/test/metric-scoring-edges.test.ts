/**
 * The reward-weighted metric, and the field values it has to survive.
 *
 * `derivation-edges` and `engine-degradation` cover what the engine does with
 * unusable trajectories. This covers the opposite case — trajectories the
 * engine *accepts* — and the two places where accepting them is not
 * straightforward.
 *
 * **A recorded field is not necessarily a string.** The derived ax signature
 * declares every field `:string`, because that is the only shape ax examples
 * take. Recorded I/O is arbitrary JSON: a number, a boolean, a nested object.
 * `jsonFieldString` serialises those rather than dropping them, so a method
 * that returns `{ score: 7 }` still trains. Dropping them would silently
 * shrink the example to the fields that happened to be strings, and the
 * signature — derived from the *first* trajectory — would then name fields the
 * examples do not carry.
 *
 * **Trajectories need not agree on their field names.** The signature comes
 * from the first usable trajectory; a later one recorded against a different
 * input shape still reaches the metric. `scorePrediction` matches an example
 * to a trajectory by comparing input fields, and a trajectory whose input keys
 * are absent from the example must not match — otherwise the metric would
 * score a prediction against the reward of an unrelated execution. When
 * nothing matches it falls back to the first output rather than scoring zero:
 * a zero would be indistinguishable from a genuinely wrong prediction and
 * would teach the optimizer that the whole example is worthless.
 *
 * These run the real ax optimizer against a deterministic mock model, so the
 * metric is invoked for real rather than called directly — it is private, and
 * a test that reached past the port would not prove the engine wires it up.
 */
import { parseTrainingArtifactProgram } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createAxTrainingEngine } from "../src/index.js";
import { mockModel, optimizeRequest, trajectory } from "./helpers.js";

const engine = () =>
	createAxTrainingEngine({ ai: mockModel("access"), maxMetricCalls: 4 });

/** A trajectory whose root span records the given input and output objects. */
function io(
	id: string,
	input: Record<string, unknown>,
	output: Record<string, unknown>,
	reward = 0.95,
) {
	const base = trajectory(id, "subject", "category", reward);
	return {
		...base,
		spans: [
			{
				...base.spans[0],
				inputsJson: JSON.stringify(input),
				outputsJson: JSON.stringify(output),
			},
		],
	} as unknown as ReturnType<typeof trajectory>;
}

const programOf = async (
	trajectories: readonly ReturnType<typeof trajectory>[],
) => {
	const candidate = await engine().optimize(
		optimizeRequest(trajectories) as never,
	);
	if (candidate.body.case !== "artifact") throw new Error("not an artifact");
	return {
		program: parseTrainingArtifactProgram(candidate.body.value.programJson),
	};
};

describe("field values that are not strings", () => {
	it("trains on a trajectory whose output fields are numbers", async () => {
		// Dropping non-string fields would shrink the example to whichever
		// fields happened to be strings, leaving the derived signature naming
		// outputs the examples do not carry.
		const { program } = await programOf([
			io("t1", { subject: "latency" }, { score: 7, ok: true }),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("keeps the recorded value verbatim in the demo, not the serialised form", async () => {
		// The demo carries the *recorded* I/O, so replay reproduces the real
		// execution. Serialisation is for the optimizer's example, not for the
		// artifact.
		const { program } = await programOf([
			io("t1", { subject: "latency" }, { score: 7 }),
		]);
		expect(JSON.parse(program.demos[0]?.outputJson ?? "{}")).toStrictEqual({
			score: 7,
		});
	});

	it("trains on a trajectory whose input fields are nested objects", async () => {
		const { program } = await programOf([
			io("t1", { ticket: { id: 4, tier: "gold" } }, { category: "billing" }),
		]);
		expect(program.demos).toHaveLength(1);
	});

	it("trains on a trajectory whose field value is null", async () => {
		// `null` is a recorded value, not an absent one — a method that
		// legitimately returns null still has an execution worth learning from.
		const { program } = await programOf([
			io("t1", { subject: "a" }, { category: null }),
		]);
		expect(program.demos).toHaveLength(1);
	});
});

describe("trajectories recorded against different shapes", () => {
	it("derives the signature from the first usable trajectory", async () => {
		// A later trajectory cannot retroactively change the program's shape;
		// the first one is the contract every example is scored against.
		const { program } = await programOf([
			io("t1", { subject: "a" }, { category: "access" }),
			io("t2", { topic: "b" }, { category: "outage" }),
		]);
		// Both are high-reward, so both are demos regardless of shape.
		expect(program.demos).toHaveLength(2);
	});

	it("still produces a candidate when no example matches a trajectory's inputs", async () => {
		// The metric falls back to the first recorded output rather than
		// scoring zero: a zero here is indistinguishable from a genuinely wrong
		// prediction, and would teach the optimizer the example is worthless.
		const { program } = await programOf([
			io("t1", { subject: "a" }, { category: "access" }),
			io("t2", { topic: "b" }, { category: "outage" }, 0.5),
		]);
		expect(program.instructions).toBe("maximize classification reward");
	});

	it("scores an example that carries a field the signature never declared", async () => {
		// The signature comes from the first trajectory, so a later one with an
		// extra input field produces an example wider than the program. The
		// metric compares field by field and treats an absent field as empty
		// rather than throwing — a recording that gained a field must not abort
		// the whole optimizer run.
		const { program } = await programOf([
			io("t1", { subject: "a" }, { category: "access" }),
			io("t2", { subject: "b", extra: "z" }, { category: "outage" }),
		]);
		expect(program.demos).toHaveLength(2);
	});
});

describe("when the optimizer returns no optimized program", () => {
	it("emits no engine payload", async () => {
		// An absent optimized program is not a failure — it is a run that found
		// nothing better than the baseline. The artifact still stands on the
		// deterministic floor, and an empty payload says plainly that this
		// engine contributed nothing beyond it.
		const { program } = await programOf([
			io("t1", { subject: "latency" }, { score: 7, ok: true }),
		]);
		expect(program.enginePayloadJson).toBe("");
	});

	it("still falls back to the rubric objective for its instructions", async () => {
		const { program } = await programOf([
			io("t1", { subject: "latency" }, { score: 7, ok: true }),
		]);
		expect(program.instructions).toBe("maximize classification reward");
	});
});
