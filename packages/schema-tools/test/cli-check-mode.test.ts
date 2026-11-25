import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { runCodegen } from "../src/codegen.js";
import { parseCodegenArgv } from "../src/parse.js";
import {
	FIXTURE_WORKSPACE,
	makeTempRepo,
	removeTempRepo,
} from "./support/temp-workspace.js";

const INTEGRATION_TIMEOUT_MS = 60_000;

// One scaffolded repo for the whole file: each test restores what it tampers.
let repoRoot: string;
let generatedFile: string;
let validFixturesDir: string;
let invalidFixturesDir: string;

beforeAll(async () => {
	repoRoot = await makeTempRepo({ workspace: FIXTURE_WORKSPACE });
	const widgets = join(repoRoot, "packages", "widgets");
	generatedFile = join(widgets, "src", "_generated", "widget_pb.ts");
	validFixturesDir = join(widgets, "data-models", "fixtures", "valid");
	invalidFixturesDir = join(widgets, "data-models", "fixtures", "invalid");
	// Write mode materializes the golden generated tree the checks compare to.
	const report = await runCodegen(parseCodegenArgv([], repoRoot));
	expect(report.status).toBe("CLEAN");
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
	await removeTempRepo(repoRoot);
});

describe("hobo-codegen --check on a clean workspace", () => {
	it(
		"exits 0 with a CLEAN json envelope and evaluates both CUE fixture lanes",
		async () => {
			const result = await runCli(["--check", "--json"], repoRoot);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.status).toBe("CLEAN");
			expect(envelope.drift).toEqual([]);
			// CLEAN implies the valid fixture vetted and the invalid one was rejected.
			expect(envelope.cueViolations).toEqual([]);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"prints a human summary without --json",
		async () => {
			const result = await runCli(["--check"], repoRoot);
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trimEnd().split("\n");
			expect(lines[0]).toBe("status: CLEAN");
			expect(lines[1]).toMatch(/^durationMs: \d+$/);
		},
		INTEGRATION_TIMEOUT_MS,
	);
});

describe("hobo-codegen --check drift semantics", () => {
	it(
		"reports 'changed' for a tampered generated file and leaves disk untouched",
		async () => {
			const before = await readFile(generatedFile, "utf8");
			try {
				await writeFile(generatedFile, `${before}// tampered\n`);
				const result = await runCli(["--check", "--json"], repoRoot);
				expect(result.exitCode).toBe(1);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.status).toBe("DRIFT");
				expect(envelope.drift).toEqual([
					{ path: "widgets/widget_pb.ts", kind: "changed" },
				]);
				// Check mode never repairs the tree.
				expect(await readFile(generatedFile, "utf8")).toBe(
					`${before}// tampered\n`,
				);
			} finally {
				await writeFile(generatedFile, before);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"reports 'removed' for a deleted generated file and human drift lines",
		async () => {
			const before = await readFile(generatedFile, "utf8");
			try {
				await rm(generatedFile);
				const result = await runCli(["--check"], repoRoot);
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toContain("status: DRIFT");
				expect(result.stdout).toContain("drift: removed widgets/widget_pb.ts");
			} finally {
				await writeFile(generatedFile, before);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"reports 'added' for a stray protobuf output in the generated tree",
		async () => {
			const stray = join(
				repoRoot,
				"packages",
				"widgets",
				"src",
				"_generated",
				"stray_pb.ts",
			);
			try {
				await writeFile(stray, "export const stray = true;\n");
				const result = await runCli(["--check", "--json"], repoRoot);
				expect(result.exitCode).toBe(1);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.status).toBe("DRIFT");
				expect(envelope.drift).toEqual([
					{ path: "widgets/stray_pb.ts", kind: "added" },
				]);
			} finally {
				await rm(stray, { force: true });
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"write mode heals drift back to CLEAN",
		async () => {
			const before = await readFile(generatedFile, "utf8");
			await writeFile(generatedFile, "// clobbered\n");
			const written = await runCodegen(parseCodegenArgv([], repoRoot));
			expect(written.status).toBe("CLEAN");
			expect(await readFile(generatedFile, "utf8")).toBe(before);
			const result = await runCli(["--check", "--json"], repoRoot);
			expect(result.exitCode).toBe(0);
		},
		INTEGRATION_TIMEOUT_MS,
	);
});

describe("hobo-codegen --check CUE lane failures", () => {
	it(
		"flags a valid fixture that the schema rejects, and ERROR outranks DRIFT",
		async () => {
			const brokenFixture = join(validFixturesDir, "broken.json");
			const before = await readFile(generatedFile, "utf8");
			try {
				await writeFile(brokenFixture, `{"id":"","size":-2}\n`);
				await writeFile(generatedFile, `${before}// tampered\n`);
				const result = await runCli(["--check", "--json"], repoRoot);
				expect(result.exitCode).toBe(1);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.status).toBe("ERROR");
				expect(envelope.cueViolations).toHaveLength(1);
				expect(envelope.cueViolations[0].package).toBe("widgets");
				expect(envelope.cueViolations[0].constraint).toBe("widget.cue");
				expect(envelope.cueViolations[0].message).toContain(
					"expected valid fixture",
				);
			} finally {
				await rm(brokenFixture, { force: true });
				await writeFile(generatedFile, before);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"flags an invalid fixture that the schema fails to reject (fail-closed)",
		async () => {
			const sneakyFixture = join(invalidFixturesDir, "actually-valid.json");
			try {
				await writeFile(sneakyFixture, `{"id":"w2","size":1}\n`);
				const result = await runCli(["--check", "--json"], repoRoot);
				expect(result.exitCode).toBe(1);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.status).toBe("ERROR");
				expect(envelope.cueViolations[0].message).toContain(
					"expected invalid fixture",
				);
				expect(envelope.cueViolations[0].message).toContain(
					"but cue vet passed",
				);
			} finally {
				await rm(sneakyFixture, { force: true });
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);
});
