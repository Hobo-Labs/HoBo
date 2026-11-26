import { describe, expect, it } from "vitest";
import { assertActEvidence } from "../scripts/act-harness.js";

function logs() {
	return [
		{ jobID: "prepare", jobResult: "success", dryrun: false },
		{
			jobID: "matrix",
			jobResult: "success",
			dryrun: false,
			matrix: { shard: "alpha" },
		},
		{
			jobID: "matrix",
			jobResult: "success",
			dryrun: false,
			matrix: { shard: "beta" },
		},
		{
			jobID: "expected_failure",
			stepResult: "failure",
			stepID: ["failure"],
			dryrun: false,
		},
		{ jobID: "expected_failure", jobResult: "success", dryrun: false },
		{ jobID: "verify", jobResult: "success", dryrun: false },
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n");
}
const events = "prepare\nmatrix-alpha\nmatrix-beta\nexpected-failure\nverify\n";
describe("act evidence gate", () => {
	it("accepts all executed jobs, both matrix rows and the observed failure", () => {
		expect(assertActEvidence(logs(), events)).toBe(5);
	});
	it("rejects act's zero-exit unsupported-label skip", () => {
		expect(() => assertActEvidence("", "")).toThrow(/skipped/);
	});
	it("rejects a missing matrix row", () => {
		expect(() =>
			assertActEvidence(
				logs()
					.split("\n")
					.filter((line) => !line.includes('"alpha"'))
					.join("\n"),
				events,
			),
		).toThrow(/skipped/);
	});
	it("rejects a dry run", () => {
		expect(() =>
			assertActEvidence(
				logs().replaceAll('"dryrun":false', '"dryrun":true'),
				events,
			),
		).toThrow(/execute/);
	});
	it("rejects an unexpected failing job", () => {
		expect(() =>
			assertActEvidence(
				logs().replace(
					'"jobID":"verify","jobResult":"success"',
					'"jobID":"verify","jobResult":"failure"',
				),
				events,
			),
		).toThrow(/successfully/);
	});
	it("requires the continue-on-error command to actually fail", () => {
		expect(() =>
			assertActEvidence(
				logs().replace('"stepResult":"failure"', '"stepResult":"success"'),
				events,
			),
		).toThrow(/exactly once/);
	});
	it("rejects skipped evidence-producing steps", () => {
		expect(() =>
			assertActEvidence(logs(), events.replace("verify\n", "")),
		).toThrow(/evidence/);
	});
	it("rejects duplicated matrix rows", () => {
		expect(() =>
			assertActEvidence(
				`${logs()}\n${JSON.stringify({ jobID: "matrix", jobResult: "success", dryrun: false, matrix: { shard: "beta" } })}`,
				events,
			),
		).toThrow(/duplicated/);
	});
});
