import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkspace } from "../check-draft-artifacts.js";

type TestArtifacts = {
	examples?: string;
	notebook?: string;
	bench?: string;
};

type TestWaiver = { requirement: string; reason: string };

describe("draft artifact checks", () => {
	const workspace = "src/draft/technical-proofs/sample";
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hobo-draft-artifacts-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function write(file: string, content: string): void {
		const target = join(root, workspace, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}

	function manifest(
		artifacts: TestArtifacts = {},
		waivers: TestWaiver[] = [],
	): void {
		write(
			"proof.json",
			JSON.stringify({
				layer: "technical",
				slug: "sample",
				title: "Sample",
				artifacts,
				waivers,
			}),
		);
	}

	it("does not require optional examples, notebooks, or benchmarks", () => {
		manifest();
		expect(checkWorkspace(workspace, { root }).problems).toEqual([]);
	});

	it("requires declared artifacts to exist", () => {
		manifest({
			examples: "examples",
			notebook: "notebook.ipynb",
			bench: "bench",
		});
		const problems = checkWorkspace(workspace, { root }).problems;
		expect(problems).toEqual(
			expect.arrayContaining([
				expect.stringContaining("no runnable examples"),
				expect.stringContaining("missing notebook"),
				expect.stringContaining("declared benchmark"),
			]),
		);
	});

	it("rejects identity scaffolds even when a manifest waives them", () => {
		manifest(
			{ examples: "examples", notebook: "notebook.ipynb", bench: "bench" },
			["examples", "notebook", "bench"].map((requirement) => ({
				requirement,
				reason: "old placeholder",
			})),
		);
		write("examples/sample.ts", 'console.log("proof-identity: ok");\n');
		write("examples/sample.expected.txt", "proof-identity: ok\n");
		write("bench/sample.bench.ts", 'bench("identity noop", () => {});\n');
		write(
			"notebook.ipynb",
			JSON.stringify({
				nbformat: 4,
				cells: [
					{ cell_type: "markdown", source: ["Hardened notebook scaffold"] },
					{ cell_type: "code", outputs: [{ text: ["done"] }] },
				],
			}),
		);
		const problems = checkWorkspace(workspace, {
			root,
			runExamples: false,
		}).problems;
		expect(
			problems.filter(
				(problem) =>
					problem.includes("only checks proof identity") ||
					problem.includes("only reports proof identity"),
			),
		).toHaveLength(3);
	});

	it("executes declared examples and validates their output", () => {
		manifest({ examples: "examples" });
		write("examples/sample.ts", "console.log(2 + 3);\n");
		write("examples/sample.expected.txt", "5\n");
		expect(checkWorkspace(workspace, { root }).problems).toEqual([]);
		write("examples/sample.expected.txt", "6\n");
		expect(checkWorkspace(workspace, { root }).problems).toEqual([
			expect.stringContaining("output does not match"),
		]);
	});
});
