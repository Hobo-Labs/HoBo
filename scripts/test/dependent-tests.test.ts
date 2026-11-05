import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	exportTarget,
	planCommands,
	planDependentTests,
	type Repo,
	type TestGraph,
	type TestPlan,
	turboTestGraph,
} from "../ci/dependent-tests.mts";

const manifest = (name: string, test: string, extra = {}) =>
	JSON.stringify({ name, scripts: { test }, ...extra });

const sources = new Map([
	[
		"packages/lib/package.json",
		manifest("@t/lib", "vitest run", {
			exports: {
				".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
				"./client": {
					types: "./dist/client.d.ts",
					default: "./dist/client.js",
				},
				"./feat/*": "./dist/feat/*.js",
			},
		}),
	],
	[
		"packages/lib/src/index.ts",
		'export * from "./client.js";\nexport * from "./worker.js";\n',
	],
	["packages/lib/src/client.ts", "export const c = 1;\n"],
	[
		"packages/lib/src/worker.ts",
		'import { c } from "./client.js";\nexport const w = c;\n',
	],
	["packages/lib/src/feat/a.ts", "export const a = 1;\n"],
	["packages/lib/scripts/daemon.mts", 'import "../src/worker.js";\n'],
	["packages/lib/fixtures/x.json", "{}\n"],
	["packages/lib/test/lib.test.ts", 'import "../src/index.js";\n'],
	[
		"packages/app/package.json",
		manifest("@t/app", "vitest run", { exports: { ".": "./dist/cli.js" } }),
	],
	["packages/app/vitest.config.ts", "export default {};\n"],
	[
		"packages/app/src/cli.ts",
		[
			'import { c } from "@t/lib/client";',
			'const daemon = new URL("../../lib/scripts/daemon.mts", import.meta.url);',
			"export { c, daemon };",
			"",
		].join("\n"),
	],
	["packages/app/src/bin/app.ts", 'import "../cli.js";\n'],
	[
		"packages/app/test/cli.test.ts",
		'const bin = new URL("../dist/bin/app.js", import.meta.url);\n',
	],
	["packages/app/test/pure.test.ts", 'import { strict } from "node:assert";\n'],
	["packages/app/test/root.test.ts", 'import "@t/lib";\n'],
	["packages/app/test/feat.test.ts", 'import "@t/lib/feat/a";\n'],
	[
		"packages/app/test/data.test.ts",
		'const dir = join(here, "../../lib/fixtures");\n',
	],
	["packages/app/test/computed.test.ts", "await import(name);\n"],
	[
		"packages/app/test/layers.test.ts",
		[
			"// Reads nothing from `packages/lib/`; it lists it.",
			'const prefix = "packages/";',
			"",
		].join("\n"),
	],
	["packages/tool/package.json", manifest("@t/tool", "node --test test/*.ts")],
	["packages/tool/test/t.test.ts", 'import "@t/lib/client";\n'],
	["packages/conf/package.json", manifest("@t/conf", "vitest run")],
	["packages/conf/vitest.config.ts", 'import { c } from "@t/lib/client";\n'],
	["packages/conf/test/c.test.ts", 'import { strict } from "node:assert";\n'],
	["packages/none/package.json", manifest("@t/none", "vitest run")],
	["packages/none/test/x.test.ts", 'const guide = "../../../docs/guide.md";\n'],
	["packages/none/test/y.test.ts", "await import(name);\n"],
	["docs/guide.md", "# guide\n"],
	["docs/other.md", "# other\n"],
	["pnpm-lock.yaml", "lockfileVersion: 9\n"],
]);

const repo: Repo = {
	files: new Set(sources.keys()),
	read: (path) => sources.get(path),
	workspaces: [
		{ dir: "packages/lib", name: "@t/lib", dependencies: [] },
		{ dir: "packages/app", name: "@t/app", dependencies: ["@t/lib"] },
		{ dir: "packages/tool", name: "@t/tool", dependencies: ["@t/lib"] },
		{ dir: "packages/conf", name: "@t/conf", dependencies: ["@t/lib"] },
		{ dir: "packages/none", name: "@t/none", dependencies: [] },
	],
};

function scoped(plan: TestPlan) {
	assert.equal(plan.mode, "scoped");
	if (plan.mode !== "scoped") throw new Error("unreachable");
	return {
		full: plan.full,
		subsets: Object.fromEntries(plan.subsets),
		skipped: plan.skipped,
	};
}

describe("planDependentTests", () => {
	it("runs only the dependent tests whose closure reaches a worker-only file", () => {
		assert.deepEqual(
			scoped(planDependentTests(["packages/lib/src/worker.ts"], repo)),
			{
				full: ["packages/lib", "packages/tool"],
				subsets: {
					"packages/app": ["test/computed.test.ts", "test/root.test.ts"],
				},
				skipped: ["packages/conf"],
			},
		);
	});

	it("follows an exported subpath, a spawned dist bin and a vitest config", () => {
		assert.deepEqual(
			scoped(planDependentTests(["packages/lib/src/client.ts"], repo)),
			{
				full: ["packages/conf", "packages/lib", "packages/tool"],
				subsets: {
					"packages/app": [
						"test/cli.test.ts",
						"test/computed.test.ts",
						"test/root.test.ts",
					],
				},
				skipped: [],
			},
		);
	});

	it("resolves an exports wildcard to the one file it names", () => {
		const plan = scoped(
			planDependentTests(["packages/lib/src/feat/a.ts"], repo),
		);
		assert.deepEqual(plan.subsets["packages/app"], [
			"test/computed.test.ts",
			"test/feat.test.ts",
		]);
	});

	it("counts a named program of another package as that file, not its imports", () => {
		const daemon = scoped(
			planDependentTests(["packages/lib/scripts/daemon.mts"], repo),
		);
		assert.deepEqual(daemon.subsets["packages/app"], [
			"test/cli.test.ts",
			"test/computed.test.ts",
		]);
	});

	it("follows a path literal into another package's directory", () => {
		const plan = scoped(
			planDependentTests(["packages/lib/fixtures/x.json"], repo),
		);
		assert.deepEqual(plan.subsets["packages/app"], [
			"test/computed.test.ts",
			"test/data.test.ts",
		]);
	});

	it("runs a test outside the changed packages only when it reaches the path", () => {
		assert.deepEqual(scoped(planDependentTests(["docs/guide.md"], repo)), {
			full: [],
			subsets: { "packages/none": ["test/x.test.ts"] },
			skipped: [],
		});
		assert.deepEqual(scoped(planDependentTests(["docs/other.md"], repo)), {
			full: [],
			subsets: {},
			skipped: [],
		});
	});

	it("runs the whole workspace for a workspace-wide input or an empty diff", () => {
		assert.equal(planDependentTests(["pnpm-lock.yaml"], repo).mode, "all");
		assert.equal(planDependentTests([""], repo).mode, "all");
	});

	it("keeps a scripts-only root package.json edit scoped with a root reader", () => {
		const scriptsOnly = (path: string, side: "base" | "head") =>
			path === "package.json"
				? JSON.stringify({ scripts: { test: side } })
				: undefined;
		const plan = planDependentTests(
			["package.json", "docs/guide.md"],
			repo,
			scriptsOnly,
		);
		assert.equal(plan.mode, "scoped");
		// Without the reader the same diff widens, as it did in merge groups.
		assert.equal(
			planDependentTests(["package.json", "docs/guide.md"], repo).mode,
			"all",
		);
	});

	it("still widens for a root dependency edit with a root reader", () => {
		const dependencyEdit = (path: string, side: "base" | "head") =>
			path === "package.json"
				? JSON.stringify({ devDependencies: { tsx: side } })
				: undefined;
		assert.equal(
			planDependentTests(["package.json"], repo, dependencyEdit).mode,
			"all",
		);
	});
});

describe("exportTarget", () => {
	it("reads a string, a condition map, a subpath map and a wildcard", () => {
		assert.equal(exportTarget({ exports: "./dist/x.js" }, "."), "./dist/x.js");
		assert.equal(
			exportTarget({ exports: { types: "./a.d.ts", import: "./a.js" } }, "."),
			"./a.js",
		);
		assert.equal(
			exportTarget(
				{ exports: { "./c": { node: { default: "./c.js" } } } },
				"./c",
			),
			"./c.js",
		);
		assert.equal(
			exportTarget({ exports: { "./f/*.js": "./dist/f/*.js" } }, "./f/a/b.js"),
			"./dist/f/a/b.js",
		);
		assert.equal(
			exportTarget({ exports: { "./c": "./c.js" } }, "./d"),
			undefined,
		);
	});

	it("falls back to module or main without exports", () => {
		assert.equal(exportTarget({ main: "./m.js" }, "."), "./m.js");
		assert.equal(
			exportTarget({ module: "./e.js", main: "./m.js" }, "."),
			"./e.js",
		);
		assert.equal(exportTarget({}, "./deep/x.js"), "./deep/x.js");
	});
});

describe("planCommands", () => {
	const plan: TestPlan = {
		mode: "scoped",
		full: ["packages/lib"],
		subsets: new Map([["packages/app", ["test/a.test.ts", "test/b.test.ts"]]]),
		skipped: [],
	};

	const graph: TestGraph = (dirs) => {
		assert.deepEqual(dirs, ["packages/lib", "packages/app"]);
		return [
			{ taskId: "@t/lib#build", task: "build", directory: "packages/lib" },
			{ taskId: "@t/lib#test", task: "test", directory: "packages/lib" },
			{ taskId: "@t/app#build", task: "build", directory: "packages/app" },
			{ taskId: "@t/extra#build", task: "build", directory: "packages/extra" },
			{ taskId: "@t/app#test", task: "test", directory: "packages/app" },
		];
	};

	it("builds once from turbo's test graph, then runs each subset's test task alone", () => {
		// A subset that built with `turbo run build` and then ran vitest itself
		// skipped `@hobo/hobo#test`'s `@hobo/adapter-hono#build`, and main failed
		// tests the PR run passed. One that passed its files through `turbo run
		// test` rebuilt its whole graph uncached, because turbo hashes the
		// pass-through into every task of the run.
		assert.deepEqual(
			planCommands(plan, ["--anon-profile=p.json"], "1", graph),
			[
				[
					"exec",
					"turbo",
					"run",
					"@t/lib#build",
					"@t/lib#test",
					"@t/app#build",
					"@t/extra#build",
					"--continue",
					"--concurrency=1",
					"--anon-profile=p.json",
				],
				[
					"exec",
					"turbo",
					"run",
					"test",
					"--filter=./packages/app",
					"--only",
					"--concurrency=1",
					"--",
					"--passWithNoTests",
					"test/a.test.ts",
					"test/b.test.ts",
				],
			],
		);
	});

	it("runs whole suites alone as one test task, without reading the graph", () => {
		const unread: TestGraph = () => assert.fail("graph read");
		assert.deepEqual(
			planCommands(
				{
					mode: "scoped",
					full: ["packages/lib"],
					subsets: new Map(),
					skipped: [],
				},
				[],
				"1",
				unread,
			),
			[
				[
					"exec",
					"turbo",
					"run",
					"test",
					"--filter=./packages/lib",
					"--continue",
					"--concurrency=1",
				],
			],
		);
		assert.deepEqual(
			planCommands({ mode: "all", reason: "lockfile" }, [], "100%", unread),
			[["exec", "turbo", "run", "test", "--concurrency=100%"]],
		);
	});

	it("the build-once call carries @hobo/hobo#test's extra dependsOn from the real turbo graph", () => {
		const commands = planCommands(
			{
				mode: "scoped",
				full: [],
				subsets: new Map([["packages/hobo", ["test/a.test.ts"]]]),
				skipped: [],
			},
			[],
			"1",
			turboTestGraph,
		);
		const build = commands[0] ?? [];
		assert.ok(build.includes("@hobo/adapter-hono#build"));
		assert.ok(build.includes("@hobo/hobo#build"));
		assert.ok(!build.includes("@hobo/hobo#test"));
		assert.ok(!build.includes("--"));
	});
});
