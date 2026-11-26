import { describe, expect, it } from "vitest";

import { changedDirs, foldGateReport, gateSuite } from "../src/gate.js";

describe("gateSuite", () => {
	it("mirrors the pr-gate lanes: agent:check, turbo affected, build:packages", () => {
		const suite = gateSuite({
			base: "origin/main",
			changedPackageDirs: ["cli"],
			changedExampleDirs: ["ci-runner-balancing"],
		});
		expect(suite.map((gate) => gate.id)).toStrictEqual([
			"agent-check",
			"turbo-affected",
			"build-packages",
		]);
		const turbo = suite[1];
		expect(turbo?.args).toContain("--filter=./packages/cli");
		expect(turbo?.args).toContain("--filter=./examples/ci-runner-balancing");
	});

	it("skips the turbo lane when no package or example paths changed", () => {
		const suite = gateSuite({
			base: "origin/main",
			changedPackageDirs: [],
			changedExampleDirs: [],
		});
		expect(suite.map((gate) => gate.id)).toStrictEqual([
			"agent-check",
			"build-packages",
		]);
	});
});

describe("changedDirs", () => {
	it("derives unique sorted top-level dirs under the parent", () => {
		expect(
			changedDirs(
				[
					"examples/ci-runner-balancing/src/gate.ts",
					"examples/ci-runner-balancing/README.md",
					"examples/hello-bindle/src/api.ts",
					"docs/design/index.md",
				],
				"examples",
			),
		).toStrictEqual(["ci-runner-balancing", "hello-bindle"]);
	});
});

describe("foldGateReport", () => {
	const base = {
		headSha: "abc",
		base: "origin/main",
		seq: "s",
		host: "h",
	};

	it("passes only when every gate exited 0 and emits golden.Passed", () => {
		const report = foldGateReport({
			...base,
			results: [
				{ id: "a", command: "x", exitCode: 0, durationMs: 10 },
				{ id: "b", command: "y", exitCode: 0, durationMs: 10 },
			],
		});
		expect(report.passed).toBe(true);
		expect(
			report.events.filter((event) => event.family === "golden.Ran"),
		).toHaveLength(2);
		expect(
			report.events.some((event) => event.family === "golden.Passed"),
		).toBe(true);
		expect(report.markdown).toContain("PASSED");
	});

	it("fails on any non-zero exit and withholds golden.Passed", () => {
		const report = foldGateReport({
			...base,
			results: [
				{ id: "a", command: "x", exitCode: 0, durationMs: 10 },
				{ id: "b", command: "y", exitCode: 2, durationMs: 10 },
			],
		});
		expect(report.passed).toBe(false);
		expect(
			report.events.some((event) => event.family === "golden.Passed"),
		).toBe(false);
		expect(report.markdown).toContain("FAILED");
	});

	it("never passes an empty suite", () => {
		expect(foldGateReport({ ...base, results: [] }).passed).toBe(false);
	});
});
