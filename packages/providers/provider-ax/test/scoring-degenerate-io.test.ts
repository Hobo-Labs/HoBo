/**
 * Trajectories whose recorded I/O parses but carries nothing.
 *
 * `derivation-edges` covers I/O the engine rejects for being unparseable;
 * `metric-scoring-edges` covers I/O it accepts and scores. This is the gap
 * between them, and it was a defect: `{}` is well-formed JSON and a perfectly
 * good object, so `rootSpanIo` accepted it — and the signature, derived from
 * the *first* usable trajectory's field names, came out as `... -> ` with
 * nothing after the arrow.
 *
 * ax rejects that with `AxSignatureValidationError`, thrown straight out of
 * `optimize`. A third-party error escaping a port boundary is the worst shape
 * a failure can take here: the caller gets a stack trace naming a library it
 * did not choose, for a condition this engine already has a clear refusal for
 * ("no trajectory with recorded root-span inputs/outputs").
 *
 * The fix is one check in `rootSpanIo`: an object with no keys is unusable,
 * the same as one that did not parse. That turns the whole class into the
 * engine's own named refusal, and — because an empty output alongside usable
 * ones is now simply skipped — leaves a run with *some* usable trajectories
 * working rather than failing.
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

/**
 * The program inside a candidate. The candidate carries a `body` oneof rather
 * than a flat artifact, so the case has to be checked before the value is
 * read -- a candidate that came back as something else would otherwise fail
 * here as an undefined property rather than as the wrong shape.
 */
const programOf = (candidate: {
	body: { case?: string; value?: { programJson?: string } };
}) => {
	if (candidate.body.case !== "artifact") throw new Error("not an artifact");
	return parseTrainingArtifactProgram(
		String(candidate.body.value?.programJson ?? ""),
	);
};

describe("a trajectory with an empty recorded output", () => {
	// `{}` parses to an object, so it used to reach signature derivation.
	// Now it is unusable, and an unusable trajectory among usable ones is
	// simply skipped.
	const withEmpty = () => [
		io("t1", { ticket: "cannot log in" }, {}),
		io("t2", { ticket: "password reset" }, { category: "access" }),
	];

	it("still produces a candidate", async () => {
		// One useless trajectory among usable ones must not fail the run --
		// recorded I/O comes from production, and a single empty output is an
		// ordinary thing to find there. Before the fix this threw
		// AxSignatureValidationError out of the port.
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest(withEmpty()) as never,
		);
		expect(candidate).toBeDefined();
	});

	it("learns from the trajectory that does carry an output", async () => {
		// The useless one must not take the usable one down with it.
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest(withEmpty()) as never,
		);
		expect(programOf(candidate).demos.length).toBeGreaterThan(0);
	});

	it("records both trajectories in provenance regardless", async () => {
		// Provenance is what the candidate was derived from, not what turned
		// out to be useful -- dropping one would make the record
		// unreproducible.
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest(withEmpty()) as never,
		);
		expect(candidate.provenance.trajectoryHashes.length).toBe(2);
	});

	it("refuses in the engine's own words when every output is empty", async () => {
		// Nothing usable at all. The refusal names the condition rather than
		// surfacing ax's signature parser.
		await expect(
			engine().optimize(
				// SAFETY: the fixture is the request shape the port parses.
				optimizeRequest([
					io("t1", { ticket: "cannot log in" }, {}),
					io("t2", { ticket: "password reset" }, {}),
				]) as never,
			),
		).rejects.toThrow(/no trajectory with recorded root-span/);
	});

	it("does not surface the ax signature error", async () => {
		// The specific regression. A caller should never see a library it did
		// not choose named in an error from this port.
		await expect(
			engine().optimize(
				// SAFETY: the fixture is the request shape the port parses.
				optimizeRequest([io("t1", { ticket: "cannot log in" }, {})]) as never,
			),
		).rejects.not.toThrow(/AxSignature/);
	});
});

describe("a trajectory with an empty recorded input", () => {
	// The mirror case, and the same fix covers it: a signature with nothing
	// before the arrow is just as invalid as one with nothing after it.
	it("skips it and uses the trajectory that has both", async () => {
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest([
				io("t1", {}, { category: "access" }),
				io("t2", { ticket: "password reset" }, { category: "access" }),
			]) as never,
		);
		expect(programOf(candidate).demos.length).toBeGreaterThan(0);
	});

	it("refuses in the engine's own words when every input is empty", async () => {
		await expect(
			engine().optimize(
				// SAFETY: the fixture is the request shape the port parses.
				optimizeRequest([
					io("t1", {}, { category: "access" }),
					io("t2", {}, { category: "access" }),
				]) as never,
			),
		).rejects.toThrow(/no trajectory with recorded root-span/);
	});
});

describe("a trajectory whose reward is zero", () => {
	// Reward weights the metric. Zero is a legitimate recorded outcome -- an
	// execution that did the wrong thing -- and it must not be confused with a
	// missing reward.
	it("still produces a candidate", async () => {
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest([
				io("t1", { ticket: "cannot log in" }, { category: "access" }, 0),
				io("t2", { ticket: "password reset" }, { category: "access" }, 0.95),
			]) as never,
		);
		expect(candidate).toBeDefined();
	});

	it("keeps a zero-reward trajectory out of the demos", async () => {
		// Demos are examples the model is shown. An execution that scored zero
		// is an example of the wrong answer, and showing it would teach exactly
		// the behaviour the run is trying to move away from.
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest([
				io("t1", { ticket: "cannot log in" }, { category: "wrong" }, 0),
				io("t2", { ticket: "password reset" }, { category: "access" }, 0.95),
			]) as never,
		);
		const demos = programOf(candidate).demos;
		expect(JSON.stringify(demos)).not.toContain("wrong");
	});

	it("still records the zero-reward trajectory in provenance", async () => {
		// It was part of the input even though it taught nothing.
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest([
				io("t1", { ticket: "cannot log in" }, { category: "wrong" }, 0),
				io("t2", { ticket: "password reset" }, { category: "access" }, 0.95),
			]) as never,
		);
		expect(candidate.provenance.trajectoryHashes.length).toBe(2);
	});
});

describe("a prediction that answers fewer fields than the signature declares", () => {
	// The signature is derived from the recorded output's field names, and the
	// model is free to answer with only some of them. `predicted[key] ?? ""`
	// is what turns a missing field into a wrong answer rather than an
	// `undefined` compared against a string -- which would count as agreement
	// with an equally-missing expected value and quietly reward the model for
	// saying nothing.
	const twoFields = () => [
		io(
			"t1",
			{ ticket: "cannot log in" },
			{ category: "access", priority: "high" },
		),
		io(
			"t2",
			{ ticket: "password reset" },
			{ category: "access", priority: "low" },
		),
	];

	it("still produces a candidate", async () => {
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest(twoFields()) as never,
		);
		expect(candidate).toBeDefined();
	});

	it("keeps both declared fields in the demos", async () => {
		// The demos come from the recording, not from what the model managed
		// to answer -- dropping the field the model missed would teach the
		// signature it was never expected.
		const demos = programOf(
			await engine().optimize(
				// SAFETY: the fixture is the request shape the port parses.
				optimizeRequest(twoFields()) as never,
			),
		).demos;
		expect(JSON.stringify(demos)).toContain("priority");
	});

	it("scores partial agreement without failing the run", async () => {
		// The mock answers only the category. A metric that threw, or that
		// scored `undefined === undefined` as a match, would either kill the
		// run or reward the omission.
		const candidate = await engine().optimize(
			// SAFETY: the fixture is the request shape the port parses.
			optimizeRequest(twoFields()) as never,
		);
		expect(programOf(candidate).instructions).toBeTypeOf("string");
	});
});
