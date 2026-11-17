import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	isNodeTestFile,
	isNodeTestSource,
} from "../lib/unit-test-selection.ts";
import { selectRelevantChecks } from "../relevant-check-policy.ts";

const root = join(import.meta.dirname, "..", "..");
const scriptTests = globSync("scripts/test/*.test.ts", { cwd: root }).sort();
const runnerFor = (file: string) =>
	isNodeTestFile(join(root, file)) ? "node --test" : "vitest";

describe("script test runners", () => {
	it("classifies runtime imports without treating fixture strings or type imports as tests", () => {
		for (const source of [
			'import { test } from "node:test";',
			'import "node:test";',
			'const test = require("node:test");',
			"const test = require(`node:test`);",
			'const test = await import("node:test");',
			'import test = require("node:test");',
			'export { test } from "node:test";',
		])
			assert.equal(isNodeTestSource(source), true, source);
		for (const source of [
			"const fixture = 'import { test } from \"node:test\";';",
			'// import { test } from "node:test";',
			'const fixture = `from "node:test"`;',
			'const pattern = /from "node:test"/;',
			'import type { TestContext } from "node:test";',
			'import type TestContext = require("node:test");',
			'import { type TestContext } from "node:test";',
			'export type { TestContext } from "node:test";',
			'export { type TestContext } from "node:test";',
			'import { test } from "vitest";',
		])
			assert.equal(isNodeTestSource(source), false, source);
	});

	it("gives every scripts test exactly one runner, and test:scripts runs both", () => {
		assert.ok(scriptTests.length > 0);
		for (const file of scriptTests) {
			if (runnerFor(file) === "node --test") continue;
			assert.match(
				readFileSync(join(root, file), "utf8"),
				/from "vitest"/u,
				`${file} imports neither node:test nor vitest`,
			);
		}
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
