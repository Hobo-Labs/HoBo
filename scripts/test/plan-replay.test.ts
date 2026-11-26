import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Repo, TestPlan } from "../ci/dependent-tests.mts";
import { importGraph, missed, replayFailed } from "../ci/plan-replay.mts";

const sources = new Map([
	[
		"packages/lib/package.json",
		JSON.stringify({
			name: "@t/lib",
			exports: { ".": "./dist/index.js", "./feat/*": "./dist/feat/*.js" },
		}),
	],
	["packages/lib/tsconfig.json", "{}\n"],
	["packages/lib/src/index.ts", 'export * from "./client.js";\n'],
	["packages/lib/src/client.ts", "export const c = 1;\n"],
	["packages/lib/src/feat/a.ts", "export const a = 1;\n"],
	["packages/lib/fixtures/x.json", "{}\n"],
	["packages/lib/test/lib.test.ts", 'import "../src/index.js";\n'],
	["packages/app/package.json", JSON.stringify({ name: "@t/app" })],
	["packages/app/vitest.config.ts", 'import "./setup.js";\n'],
	["packages/app/setup.ts", "export {};\n"],
	["packages/app/src/cli.ts", 'export { c } from "@t/lib";\n'],
	["packages/app/test/cli.test.ts", 'await import("../src/cli.js");\n'],
	[
		"packages/app/test/feat.test.ts",
		'import type { a } from "@t/lib/feat/a";\n',
	],
	[
		"packages/app/test/data.test.ts",
		'const dir = join(here, "../../lib/fixtures");\n',
	],
	["packages/app/test/pure.test.ts", 'import { strict } from "node:assert";\n'],
]);

const repo: Repo = {
	files: new Set(sources.keys()),
	read: (path) => sources.get(path),
	workspaces: [
		{ dir: "packages/lib", name: "@t/lib", dependencies: [] },
		{ dir: "packages/app", name: "@t/app", dependencies: ["@t/lib"] },
	],
};

describe("the replay's check graph", () => {
	const graph = importGraph(repo);
	const reached = (path: string) => graph.reachedTests([path]).sort();

	it("owns every test file", () => {
		assert.deepEqual(Object.fromEntries(graph.tests), {
			"packages/lib/test/lib.test.ts": "packages/lib",
			"packages/app/test/cli.test.ts": "packages/app",
			"packages/app/test/feat.test.ts": "packages/app",
			"packages/app/test/data.test.ts": "packages/app",
			"packages/app/test/pure.test.ts": "packages/app",
		});
	});

	it("reaches a test through relative, dynamic, package and type-only imports", () => {
		assert.deepEqual(reached("packages/lib/src/client.ts"), [
			"packages/app/test/cli.test.ts",
			"packages/lib/test/lib.test.ts",
		]);
		assert.deepEqual(reached("packages/lib/src/feat/a.ts"), [
			"packages/app/test/feat.test.ts",
		]);
	});

	it("puts a package's vitest config in every one of its tests", () => {
		assert.deepEqual(reached("packages/app/setup.ts"), [
			"packages/app/test/cli.test.ts",
			"packages/app/test/data.test.ts",
			"packages/app/test/feat.test.ts",
			"packages/app/test/pure.test.ts",
		]);
	});

	it("reaches the importers of a package through its manifest and tsconfig", () => {
		for (const input of ["package.json", "tsconfig.json"])
			assert.deepEqual(reached(`packages/lib/${input}`), [
				"packages/app/test/cli.test.ts",
				"packages/app/test/feat.test.ts",
			]);
	});

	it("holds import edges only: a path literal is not one", () => {
		assert.deepEqual(reached("packages/lib/fixtures/x.json"), []);
	});

	it("reports the reached tests a plan neither runs whole nor lists", () => {
		const tests = reached("packages/lib/package.json");
		const plan = (
			full: string[],
			subsets: Record<string, string[]> = {},
		): TestPlan => ({
			mode: "scoped",
			full,
			subsets: new Map(Object.entries(subsets)),
			skipped: [],
		});
		assert.deepEqual(missed(plan(["packages/lib"]), tests, graph.tests), tests);
		assert.deepEqual(
			missed(
				plan(["packages/lib"], { "packages/app": ["test/cli.test.ts"] }),
				tests,
				graph.tests,
			),
			["packages/app/test/feat.test.ts"],
		);
		assert.deepEqual(missed(plan(["packages/app"]), tests, graph.tests), []);
		assert.deepEqual(
			missed({ mode: "all", reason: "lockfile" }, tests, graph.tests),
			[],
		);
	});
});

describe("the replay's exit status", () => {
	const totals = (before: number, after: number) =>
		new Map([
			["before", { misses: before }],
			["after", { misses: after }],
		]);

	it("answers for the current planner, not the one it is compared with", () => {
		assert.equal(replayFailed(totals(41, 0)), false);
		assert.equal(replayFailed(totals(0, 1)), true);
		assert.equal(replayFailed(totals(41, 1)), true);
		assert.equal(replayFailed(new Map([["after", { misses: 0 }]])), false);
	});
});
