import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	exportTarget,
	planCommands,
	planDependentTests,
	planShardCount,
	type Repo,
	readRepo,
	shardTestPlan,
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
	["packages/conf/README.md", "# conf\n"],
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

describe("workspace test shards", () => {
	it("partitions whole suites and dependent subsets exactly once", () => {
		const plan = planDependentTests(["packages/lib/src/client.ts"], repo);
		assert.equal(plan.mode, "scoped");
		if (plan.mode !== "scoped") throw new Error("expected scoped plan");
		const shards = [0, 1, 2, 3].map((index) =>
			shardTestPlan(plan, repo.workspaces, index, 4),
		);
		const full = shards.flatMap((part) =>
			part.mode === "scoped" ? part.full : [],
		);
		const subsets = shards.flatMap((part) =>
			part.mode === "scoped" ? [...part.subsets] : [],
		);
		assert.deepEqual([...full].sort(), [...plan.full].sort());
		assert.equal(new Set(full).size, full.length);
		assert.deepEqual(
			subsets.sort(([a], [b]) => a.localeCompare(b)),
			[...plan.subsets].sort(([a], [b]) => a.localeCompare(b)),
		);
		assert.equal(new Set(subsets.map(([dir]) => dir)).size, subsets.length);
	});

	it("partitions every workspace for a repo-wide plan and rejects invalid shards", () => {
		const plan: TestPlan = { mode: "all", reason: "global input" };
		const shards = [0, 1, 2, 3].map((index) =>
			shardTestPlan(plan, repo.workspaces, index, 4),
		);
		const full = shards.flatMap((part) =>
			part.mode === "scoped" ? part.full : [],
		);
		assert.deepEqual(
			[...full].sort(),
			repo.workspaces.map((ws) => ws.dir).sort(),
		);
		assert.equal(new Set(full).size, full.length);
		for (const [index, count] of [
			[-1, 4],
			[4, 4],
			[0, 0],
			[0, 65],
			[0.5, 4],
		] as const)
			assert.throws(
				() => shardTestPlan(plan, repo.workspaces, index, count),
				/invalid workspace test shard/u,
			);
		assert.throws(
			() =>
				shardTestPlan(
					{
						mode: "scoped",
						full: ["packages/lib"],
						subsets: new Map([["packages/lib", ["test/lib.test.ts"]]]),
						skipped: [],
					},
					repo.workspaces,
					0,
					4,
				),
			/both a whole suite and a subset/u,
		);
	});
});

describe("planShardCount", () => {
	const of = (suites: number): TestPlan => ({
		mode: "scoped",
		full: Array.from({ length: suites }, (_, index) => `packages/p${index}`),
		subsets: new Map(),
		skipped: [],
	});

	it("takes every shard for a repo-wide plan", () => {
		assert.equal(planShardCount({ mode: "all", reason: "lockfile" }, 8), 8);
	});

	it("takes one shard per four suites or subsets, one at least and the cap at most", () => {
		assert.equal(planShardCount(of(0), 8), 1);
		assert.equal(planShardCount(of(4), 8), 1);
		assert.equal(planShardCount(of(5), 8), 2);
		assert.equal(planShardCount(of(32), 8), 8);
		assert.equal(planShardCount(of(500), 8), 8);
		assert.equal(
			planShardCount(
				{
					mode: "scoped",
					full: ["packages/a"],
					subsets: new Map(
						Array.from({ length: 4 }, (_, index) => [
							`packages/s${index}`,
							["test/x.test.ts"],
						]),
					),
					skipped: ["packages/skipped"],
				},
				8,
			),
			2,
		);
	});

	it("covers the plan with the shards it asked for", () => {
		const plan = of(13);
		const count = planShardCount(plan, 8);
		const full = Array.from({ length: count }, (_, index) =>
			shardTestPlan(plan, [], index, count),
		).flatMap((part) => (part.mode === "scoped" ? part.full : []));
		assert.equal(count, 4);
		assert.deepEqual(
			[...full].sort(),
			Array.from({ length: 13 }, (_, index) => `packages/p${index}`).sort(),
		);
	});

	it("rejects a cap outside the shard range", () => {
		for (const max of [0, 65, 1.5, Number.NaN])
			assert.throws(
				() => planShardCount(of(1), max),
				/invalid workspace test shard/u,
			);
	});
});

describe("--plan-shards", () => {
	const script = fileURLToPath(
		new URL("../ci/dependent-tests.mts", import.meta.url),
	);
	const plan = (flag: string, changed: string) =>
		spawnSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", script, flag],
			{
				cwd: fileURLToPath(new URL("../..", import.meta.url)),
				input: changed,
				encoding: "utf8",
			},
		);

	// The workflow takes stdout as the matrix and falls back to eight shards
	// on anything else, so a stray line here would go unnoticed.
	it("prints the shard list alone on stdout and the plan on stderr", () => {
		const scopedPlan = plan("--plan-shards=8", "docs/ci/performance.md\n");
		assert.equal(scopedPlan.status, 0, scopedPlan.stderr);
		assert.match(scopedPlan.stdout, /^\[0(?:, [1-7])*\]\n$/u);
		assert.match(scopedPlan.stderr, /^dependent-tests: /u);
		const repoWide = plan("--plan-shards=3", "pnpm-lock.yaml\n");
		assert.equal(repoWide.stdout, "[0, 1, 2]\n");
		assert.match(repoWide.stderr, /whole workspace/u);
	});

	it("rejects a cap that is not a count", () => {
		for (const flag of [
			"--plan-shards",
			"--plan-shards=",
			"--plan-shards=x",
			"--plan-shards=0",
			"--plan-shards=65",
		]) {
			const bad = plan(flag, "docs/ci/performance.md\n");
			assert.equal(bad.status, 2, flag);
			assert.equal(bad.stdout, "", flag);
			assert.match(bad.stderr, /expected --plan-shards=MAX/u, flag);
		}
	});
});

function scoped(plan: TestPlan) {
	assert.equal(plan.mode, "scoped");
	if (plan.mode !== "scoped") throw new Error("unreachable");
	return {
		full: plan.full,
		subsets: Object.fromEntries(plan.subsets),
		skipped: plan.skipped,
	};
}

/** `repo` with more files: each case adds only what it is about. */
function extend(base: Repo, more: Readonly<Record<string, string>>): Repo {
	const added = new Map(Object.entries(more));
	return {
		files: new Set([...base.files, ...added.keys()]),
		read: (path) => added.get(path) ?? base.read(path),
		workspaces: base.workspaces,
	};
}

/**
 * A root vitest config with setup files, merged by a package whose `test`
 * script builds first. Neither package depends on what changes, so both are
 * bystanders, asked only whether their config reaches the path.
 */
const rootConfigRepo: Repo = {
	...extend(repo, {
		"vitest.config.ts": [
			'import { fileURLToPath } from "node:url";',
			"export default { test: { globalSetup: [",
			'	fileURLToPath(new URL("./test/setup/homes.ts", import.meta.url)),',
			"] } };",
			"",
		].join("\n"),
		"test/setup/homes.ts": "export default () => {};\n",
		"packages/heavy/package.json": manifest(
			"@t/heavy",
			"pnpm run build && vitest run",
		),
		"packages/heavy/vitest.config.ts":
			'import root from "../../vitest.config.js";\nexport default root;\n',
		"packages/heavy/test/h.test.ts": 'import { strict } from "node:assert";\n',
		"packages/merged/package.json": manifest("@t/merged", "vitest run"),
		"packages/merged/vitest.config.ts":
			'import root from "../../vitest.config.js";\nexport default root;\n',
		"packages/merged/test/m.test.ts": 'import { strict } from "node:assert";\n',
	}),
	workspaces: [
		...repo.workspaces,
		{ dir: "packages/heavy", name: "@t/heavy", dependencies: [] },
		{ dir: "packages/merged", name: "@t/merged", dependencies: [] },
	],
};

describe("a bystander whose test script is not plain vitest", () => {
	for (const path of ["vitest.config.ts", "test/setup/homes.ts"])
		it(`runs whole when its config reaches ${path}`, () => {
			assert.deepEqual(scoped(planDependentTests([path], rootConfigRepo)), {
				full: ["packages/heavy", "packages/merged"],
				subsets: {},
				skipped: [],
			});
		});

	it("runs whole when one of its tests reaches the path, and not otherwise", () => {
		const reading = extend(rootConfigRepo, {
			"packages/heavy/test/guide.test.ts":
				'const guide = "../../../docs/guide.md";\n',
		});
		assert.deepEqual(scoped(planDependentTests(["docs/guide.md"], reading)), {
			full: ["packages/heavy"],
			subsets: { "packages/none": ["test/x.test.ts"] },
			skipped: [],
		});
		// `packages/tool` (`node --test`) reaches neither and stays out.
		assert.deepEqual(
			scoped(planDependentTests(["docs/other.md"], rootConfigRepo)),
			{ full: [], subsets: {}, skipped: [] },
		);
	});
});

describe("a package that imports another by relative path", () => {
	it("runs the tests that reach the change without declaring the dependency", () => {
		const reaching = extend(repo, {
			"packages/none/test/reach.test.ts": 'import "../../lib/src/worker.js";\n',
		});
		assert.deepEqual(
			scoped(planDependentTests(["packages/lib/src/worker.ts"], reaching))
				.subsets["packages/none"],
			["test/reach.test.ts"],
		);
	});
});

describe("a bare ./ or ../ literal", () => {
	const literals = extend(repo, {
		"packages/lib/src/feat/spec.ts":
			'export const relative = (entry: string) => entry.startsWith("./");\n',
		"packages/lib/src/feat/root.ts":
			'export const root = new URL("../", import.meta.url);\n',
		"packages/app/test/spec.test.ts": 'import "@t/lib/feat/spec";\n',
		"packages/app/test/root-url.test.ts": 'import "@t/lib/feat/root";\n',
	});

	it("is no edge in a string test, and the base of a module URL is", () => {
		assert.deepEqual(
			scoped(planDependentTests(["packages/lib/src/worker.ts"], literals))
				.subsets["packages/app"],
			["test/computed.test.ts", "test/root-url.test.ts", "test/root.test.ts"],
		);
	});

	/**
	 * Whether a test importing a lib module made of `source` runs when a lib
	 * file changes that nothing imports: `src/feat/a.ts` sits under both `./`
	 * and `../` of the module, and `src/index.ts` does not import it.
	 */
	const reads = (source: string) => {
		const tree = extend(repo, {
			"packages/lib/src/feat/form.ts": `${source}\n`,
			"packages/app/test/form.test.ts": 'import "@t/lib/feat/form";\n',
		});
		return (
			scoped(planDependentTests(["packages/lib/src/feat/a.ts"], tree)).subsets[
				"packages/app"
			]?.includes("test/form.test.ts") ?? false
		);
	};

	for (const source of [
		'const root = new URL("../", import.meta.url);',
		'const root = new URL(/* package root */ "../", import.meta.url);',
		'const root = new URL("../" as string, import.meta.url);',
		'const root = new URL("../", pathToFileURL(__filename));',
		'const root = join(dirname(fileURLToPath(import.meta.url)), "../");',
		'const root = resolve(import.meta.dirname, "../");',
		'const here = join(__dirname, "./");',
		'const names = readdirSync("../");',
		'spawnSync("node", ["x"], { cwd: join(here, "../") });',
		'spawnSync("node", ["x"], { cwd: "../" });',
		'const path = (n: string) => "../" + n;',
		"const root = path.resolve(here, `../`);",
		// A path call inside a string test still reads the directory.
		'const inside = (p: string) => p.startsWith(resolve(here, "../"));',
		'const listed = (n: string) => readdirSync("./").includes(n);',
		'const roots = ["./", "../"].map((dir) => readdirSync(join(here, dir)));',
	])
		it(`is a directory edge in \`${source}\``, () => {
			assert.equal(reads(source), true);
		});

	it("is no edge only as a string test's argument, a comparison's operand or a case label", () => {
		for (const source of [
			'const t = (s: string) => s.startsWith("./");',
			'const t = (s: string) => s.startsWith("../");',
			'const t = (s: string) => s?.endsWith("../");',
			'const t = (s: string) => s.includes("../");',
			'const t = (s: string) => s.replace("./", "");',
			'const t = (s: string) => s.replace(/^src/u, "./");',
			'const t = (s: string) => s.replaceAll("../", "");',
			'const t = (s: string) => s.replaceAll(sep, "../");',
			'const t = (s: string) => s === "./";',
			'const t = (s: string) => s !== "../";',
			'const t = (s: string) => s == "./";',
			'const t = (s: string) => s != "../";',
			'const t = (s: string) => "./" === s;',
			'const t = (s: string) => "../" !== s;',
			'switch (s) {\n\tcase "./":\n\tcase "../":\n\t\tbreak;\n}',
		])
			assert.equal(reads(source), false, source);
		// The same literal one token away from a string test is kept.
		for (const source of [
			'const t = (s: string) => s.startsWith(join(here, "../"));',
			'const t = (s: string) => s.replace(readFileSync(a, "utf8"), "../");',
			'const t = (s: string) => (s === "x" ? readdirSync("../") : []);',
			'const t = { case: "../" };',
			'const t = s >= "../";',
		])
			assert.equal(reads(source), true, source);
	});

	it("stays a directory edge where the directory holds an index file", () => {
		// `packages/lib/src/index.ts` exists and does not import `feat/a.ts`:
		// an edge to it would lose every other file under `src/`.
		const tree = extend(repo, {
			"packages/lib/src/feat/root.ts":
				'export const root = new URL("../", import.meta.url);\n',
			"packages/app/test/root-url.test.ts": 'import "@t/lib/feat/root";\n',
		});
		assert.deepEqual(
			scoped(planDependentTests(["packages/lib/fixtures/x.json"], tree))
				.subsets["packages/app"],
			["test/computed.test.ts", "test/data.test.ts"],
		);
		assert.deepEqual(
			scoped(planDependentTests(["packages/lib/src/feat/a.ts"], tree)).subsets[
				"packages/app"
			],
			["test/computed.test.ts", "test/feat.test.ts", "test/root-url.test.ts"],
		);
	});
});

describe("a package's manifest and build config", () => {
	// `@t/top` imports `@t/app`, which imports `@t/lib/client`; `packages/none`
	// imports lib's source by relative path and declares nothing.
	const built: Repo = {
		...extend(repo, {
			"packages/lib/package.json": manifest("@t/lib", "vitest run", {
				scripts: {
					test: "vitest run",
					build: "tsc -p tsconfig.build.json",
					typecheck: "tsc -p tsconfig.json --noEmit",
				},
				exports: {
					".": "./dist/index.js",
					"./client": "./dist/client.js",
					"./feat/*": "./dist/feat/*.js",
				},
			}),
			"packages/lib/tsconfig.json": "{}\n",
			"packages/lib/tsconfig.build.json": "{}\n",
			"packages/lib/tsconfig.unused.json": "{}\n",
			"packages/app/tsconfig.json": "{}\n",
			"packages/top/package.json": manifest("@t/top", "vitest run"),
			"packages/top/test/top.test.ts": 'import "@t/app";\n',
			"packages/top/test/pure.test.ts":
				'import { strict } from "node:assert";\n',
			"packages/none/test/reach.test.ts": 'import "../../lib/src/worker.js";\n',
		}),
		workspaces: [
			...repo.workspaces,
			{ dir: "packages/top", name: "@t/top", dependencies: ["@t/app"] },
		],
	};
	const importersOfLib = {
		full: ["packages/conf", "packages/lib", "packages/tool"],
		subsets: {
			"packages/app": [
				"test/cli.test.ts",
				"test/computed.test.ts",
				"test/feat.test.ts",
				"test/root.test.ts",
			],
			"packages/none": ["test/reach.test.ts"],
			"packages/top": ["test/top.test.ts"],
		},
		skipped: [],
	};

	for (const path of [
		"packages/lib/package.json",
		"packages/lib/tsconfig.json",
		"packages/lib/tsconfig.build.json",
	])
		it(`runs everything that imports the package when ${path} changes`, () => {
			assert.deepEqual(
				scoped(planDependentTests([path], built)),
				importersOfLib,
			);
			// A tsconfig no script builds with is the package's own business.
			assert.deepEqual(
				scoped(
					planDependentTests(["packages/lib/tsconfig.unused.json"], built),
				),
				{
					full: ["packages/lib", "packages/tool"],
					subsets: { "packages/app": ["test/computed.test.ts"] },
					skipped: ["packages/conf", "packages/top"],
				},
			);
		});

	it("runs the importers of a package that is itself a dependent", () => {
		for (const path of [
			"packages/app/package.json",
			"packages/app/tsconfig.json",
		])
			assert.deepEqual(scoped(planDependentTests([path], built)), {
				full: ["packages/app"],
				subsets: { "packages/top": ["test/top.test.ts"] },
				skipped: [],
			});
	});
});

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

	it("runs a changed package whole even when only a test or a doc changed", () => {
		// Its tests read siblings by names the walk cannot follow, such as
		// `readPackageFile("README.md")` or a scan of the test directory.
		for (const changed of [
			"packages/app/test/pure.test.ts",
			"packages/conf/README.md",
		])
			assert.deepEqual(scoped(planDependentTests([changed], repo)).full, [
				changed.split("/").slice(0, 2).join("/"),
			]);
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

describe("the repository's own plans", { concurrency: true }, () => {
	let tree: Repo | undefined;
	const plan = (path: string) =>
		scoped(planDependentTests([path], (tree ??= readRepo())));

	// `packages/cli` merges the root config but its script builds first.
	for (const [path, full] of [
		["vitest.config.ts", ["packages/cli", "packages/hobo"]],
		[
			"test/setup/hobo-test-homes.ts",
			["packages/cli", "packages/code", "packages/hobo"],
		],
		[
			"test/setup/isolate-hobo-home.ts",
			["packages/cli", "packages/code", "packages/hobo"],
		],
	] as const)
		it(`runs the suites whose config reaches ${path}`, () => {
			assert.deepEqual(plan(path), { full, subsets: {}, skipped: [] });
		});

	it("runs a test that imports another package's source by relative path", () => {
		// `packages/code` imports `../../cli/src/cloud/loader.js` and declares no
		// dependency on @hobo/cli; 3317dcc2 changed cli and missed it.
		assert.ok(
			plan("packages/cli/src/cloud/loader.ts").subsets[
				"packages/code"
			]?.includes("test/happy-path-run.test.ts"),
		);
	});

	for (const dir of ["packages/core", "packages/cli", "packages/policy"])
		it(`runs the dependents of ${dir} when its manifest or tsconfig changes`, () => {
			// What importing the package selects: a change to its source entry.
			const manifestOf = JSON.parse(
				(tree ??= readRepo()).read(`${dir}/package.json`) ?? "{}",
			);
			const entry = exportTarget(manifestOf, ".") ?? "";
			const source = `${dir}/${entry.replace(/^\.\/dist\//u, "src/").replace(/\.js$/u, ".ts")}`;
			assert.ok(tree.files.has(source), source);
			const byEntry = plan(source);
			assert.ok(byEntry.full.length + Object.keys(byEntry.subsets).length > 1);
			for (const input of [`${dir}/package.json`, `${dir}/tsconfig.json`]) {
				const byInput = plan(input);
				for (const whole of byEntry.full)
					assert.ok(byInput.full.includes(whole), `${input}: ${whole}`);
				for (const [pkg, files] of Object.entries(byEntry.subsets))
					for (const file of files)
						assert.ok(
							byInput.full.includes(pkg) ||
								byInput.subsets[pkg]?.includes(file),
							`${input}: ${pkg}/${file}`,
						);
			}
		});

	it("plans a generated @hobo/core leaf by what imports it, not by core's `./`", () => {
		const { full, subsets, skipped } = plan(
			"packages/core/src/_generated/actor_host_port_pb.ts",
		);
		assert.deepEqual(
			[full.length, Object.keys(subsets).length, skipped.length],
			[13, 14, 106],
		);
		assert.ok(full.includes("packages/core"));
	});
});
