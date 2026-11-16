import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isNodeTestFile } from "../lib/unit-test-selection.ts";
import { selectRelevantChecks } from "../relevant-check-policy.ts";

const root = join(import.meta.dirname, "..", "..");
const scriptTests = globSync("scripts/test/*.test.ts", { cwd: root }).sort();
/** `node --test` loads a file written for node:test; Vitest loads the rest. */
const runnerFor = (file: string) =>
	isNodeTestFile(join(root, file)) ? "node --test" : "vitest";

describe("script test runners", () => {
	it("gives every scripts test exactly one runner, and test:scripts runs both", () => {
		assert.ok(scriptTests.length > 0);
		for (const file of scriptTests) {
			if (runnerFor(file) === "node --test") continue;
			// What is not a node:test file has to be one Vitest can run.
			assert.match(
				readFileSync(join(root, file), "utf8"),
				/from "vitest"/u,
				`${file} imports neither node:test nor vitest`,
			);
		}
		// One command for the directory. A bare `node --test scripts/test/*`
		// cannot load a Vitest-style file and fails once for each of them.
		const scripts: { scripts: Record<string, string> } = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		);
		assert.equal(
			scripts.scripts["test:scripts"],
			"node --import tsx scripts/run-tests.ts --category=scripts",
		);
		const runner = readFileSync(join(root, "scripts/run-tests.ts"), "utf8");
		assert.match(runner, /scripts: \["scripts\/test\/\*\.test\.ts"\]/u);
		assert.match(runner, /file\.startsWith\("scripts\/test\/"\)/u);
	});

	it("runs each scripts test a workflow names under the runner test:scripts gives it", () => {
		// Workflows name single files (`node --import tsx --test <file>`,
		// `pnpm exec vitest run <files>`). Within a step, a scripts test that
		// follows one of those two commands is run by it; one that follows
		// neither is a path filter.
		const invocations: string[] = [];
		for (const workflow of globSync(".github/workflows/*.yml", { cwd: root })) {
			const lines = readFileSync(join(root, workflow), "utf8").split("\n");
			const starts = lines.flatMap((line, index) =>
				/^\s+- [a-z-]+:/u.test(line) ? [index] : [],
			);
			for (const [position, start] of starts.entries()) {
				const step = lines.slice(start, starts[position + 1]).join("\n");
				let runner: string | undefined;
				for (const match of step.matchAll(
					/--test(?=\s|$)|vitest run(?=\s|$)|scripts\/test\/[\w.-]+\.test\.ts/gmu,
				)) {
					const token = match[0];
					if (token === "--test") runner = "node --test";
					else if (token === "vitest run") runner = "vitest";
					else if (runner !== undefined) {
						invocations.push(`${workflow}: ${token}`);
						assert.ok(scriptTests.includes(token), `${workflow}: ${token}`);
						assert.equal(runnerFor(token), runner, `${workflow}: ${token}`);
					}
				}
			}
		}
		// Both forms are in use; finding neither means the scan broke.
		assert.ok(
			invocations.some((entry) =>
				entry.startsWith(".github/workflows/hobo-ci.yml"),
			),
		);
		assert.ok(
			invocations.some((entry) =>
				entry.startsWith(".github/workflows/release-hobo.yml"),
			),
		);
	});

	it("runs each scripts test the relevant-check policy selects under that runner too", () => {
		const policy = readFileSync(
			join(root, "scripts/relevant-check-policy.ts"),
			"utf8",
		);
		const named = [
			...new Set(policy.match(/scripts\/test\/[\w.-]+\.test\.ts/gu) ?? []),
		];
		assert.ok(named.length > 0);
		let selected = 0;
		for (const changed of named) {
			assert.ok(scriptTests.includes(changed), changed);
			const { checks } = selectRelevantChecks({
				files: [changed],
				base: "origin/main",
			});
			for (const check of checks) {
				const files = check.args.filter((arg) => scriptTests.includes(arg));
				if (files.length === 0) continue;
				const runner =
					check.command === "node" && check.args.includes("--test")
						? "node --test"
						: check.args.includes("vitest")
							? "vitest"
							: undefined;
				assert.ok(runner, `${check.command} ${check.args.join(" ")}`);
				for (const file of files) {
					selected += 1;
					assert.equal(runnerFor(file), runner, file);
				}
			}
		}
		assert.ok(selected > 0);
	});
});
