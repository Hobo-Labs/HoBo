/**
 * Regression guard for the boundary checker's import scan.
 *
 * The scan was once a regex over source text, which could not tell a real
 * `import … from "@hobo/x"` from one *quoted inside a string* — and a
 * remediation message that tells a human what to type is exactly that. One such
 * message in `@hobo/identity` ("import { createLocalStationOpenBaoSecretsPort }
 * from \"@hobo/adapter-openbao\"") was enough to invent an edge that made the
 * checker report a dependency cycle between two packages where only one
 * direction exists. The scan now reads specifiers from the syntax tree; these
 * assertions are what it has to keep true whichever way it reads them.
 *
 * The assertions below are about that class of mistake rather than about the
 * current graph: the real edge must still be found, the phantom reverse edge
 * must not be, and the checker must exit clean.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

interface Report {
	readonly edges: ReadonlyArray<{
		readonly from_path: string;
		readonly to_path: string;
	}>;
	readonly violations: ReadonlyArray<{ readonly rule: string }>;
}

type BoundaryRun = {
	readonly status: number | null;
	readonly report: Report;
	/** The refusals the gate printed, one per line: `<rule>: <from> -> <to>`. */
	readonly refusals: readonly string[];
};

/** Spawn the gate on this repository, or on the workspace at `workspaceRoot`. */
function spawnGate(workspaceRoot?: string) {
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			join(root, "scripts/check-package-boundaries.mts"),
			...(workspaceRoot === undefined ? [] : [`--root=${workspaceRoot}`]),
		],
		{ cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
}

/** Run the gate and read its report and the refusals it printed. */
function run(workspaceRoot?: string): BoundaryRun {
	const result = spawnGate(workspaceRoot);
	const line = result.stdout
		.split("\n")
		.find((entry) => entry.trim().startsWith("{"));
	assert.ok(line, `no JSON report in output: ${result.stdout}${result.stderr}`);
	return {
		status: result.status,
		// SAFETY: assertion to `.parse(line) as Report }; ` is required at this boundary.
		report: JSON.parse(line) as Report,
		refusals: result.stderr
			.split("\n")
			.filter((entry) => entry.includes(" -> "))
			.sort(),
	};
}

describe("check-package-boundaries", () => {
	it("does not read an import quoted inside a string literal as a dependency", () => {
		const { status, report } = run();
		const has = (from: string, to: string): boolean =>
			report.edges.some(
				(edge) => edge.from_path === from && edge.to_path === to,
			);

		// The real dependency, declared in package.json and imported in source.
		assert.ok(
			has("packages/adapters/adapter-openbao", "packages/identity"),
			"the real adapter-openbao -> identity edge went missing",
		);
		// The phantom one, which exists only as text inside an error message.
		assert.ok(
			!has("packages/identity", "packages/adapters/adapter-openbao"),
			"a quoted import in a remediation message was counted as a dependency",
		);
		assert.deepEqual(report.violations, []);
		assert.equal(status, 0);
	});

	it("still finds ordinary imports, so the fix did not blind the scan", () => {
		const { report } = run();
		// Single-line, multi-line and re-export forms all appear in these.
		for (const [from, to] of [
			["packages/yards", "packages/core"],
			["packages/camps", "packages/bindles"],
			["packages/cloud-providers", "packages/providers/provider-azure"],
		] as const) {
			assert.ok(
				report.edges.some(
					(edge) => edge.from_path === from && edge.to_path === to,
				),
				`expected edge ${from} -> ${to}`,
			);
		}
		assert.ok(report.edges.length > 200, "the edge graph collapsed");
	});
});

/**
 * The dev-only harness exemption, on the real workspace rather than a fixture.
 *
 * `packages/packs/pack-framework` is a layer-2 adapter that lists
 * `@hobo/contract-harness` under `devDependencies` and imports it only from its
 * test suite. Under the strict layering rules that edge is a violation; it is
 * clean solely because the declared-dependency collector marks it `dev` and
 * `isDevOnlyTestHarnessEdge` exempts it. Nothing tested that end to end, so the
 * exemption could have been deleted, or the marker could have stopped being
 * set, with the only symptom being a gate that stayed green for a different
 * reason.
 */
describe("dev-only contract-harness edge", () => {
	it("is discovered, and exempted rather than absent", () => {
		const { status, report } = run();

		assert.ok(
			report.edges.some(
				(edge) =>
					edge.from_path === "packages/packs/pack-framework" &&
					edge.to_path === "packages/contract-harness",
			),
			"pack-framework -> contract-harness is missing from the graph, so a clean run proves nothing about the dev exemption",
		);
		assert.deepEqual(report.violations, []);
		assert.equal(status, 0);
	});

	it("reports one edge per package pair, so a dev sighting cannot be counted twice", () => {
		const { report } = run();
		const seen = new Set<string>();
		const duplicates: string[] = [];
		for (const edge of report.edges) {
			const key = `${edge.from_path}->${edge.to_path}`;
			if (seen.has(key)) duplicates.push(key);
			seen.add(key);
		}
		assert.deepEqual(
			duplicates,
			[],
			"mergeWorkspaceEdges must collapse the declared and source sightings of a pair into one edge; two rows means the dev marker is decided by whichever row a rule happens to read",
		);
	});
});

/**
 * The engine-neutrality rules, on a workspace that breaks them.
 *
 * Every other test in this file runs the gate on the real repository, which is
 * clean — so all they can show is that the gate does not refuse a tree with
 * nothing to refuse. The rule "an orchestrator must not import a data engine
 * at runtime" passed that way while being trivially avoidable: the scan
 * matched `from "…"` in the text, so `await import("@hobo/data-sqlite")` and
 * `require("@hobo/data-sqlite")` were not edges, a subpath import matched no
 * package, `node:sqlite` — the import the rule was written to keep out — was
 * not a workspace package and so never an edge, and only `*.ts` was read.
 *
 * Each offending form below lands on a different target, so losing one form
 * loses one named refusal.
 */
describe("engine-neutrality on a workspace that breaks it", () => {
	const workspaces: string[] = [];
	after(() => {
		for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
	});

	const manifest = (
		name: string,
		dependencies: readonly string[],
		devDependencies: readonly string[] = [],
	): string =>
		JSON.stringify({
			name,
			dependencies: Object.fromEntries(
				dependencies.map((dependency) => [dependency, "*"]),
			),
			devDependencies: Object.fromEntries(
				devDependencies.map((dependency) => [dependency, "*"]),
			),
		});

	/** The files of a workspace that keeps every rule; a case adds to them. */
	const CLEAN: readonly (readonly [string, string])[] = [
		["pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n'],
		["packages/core/package.json", manifest("@hobo/core", [])],
		[
			"packages/data-core/package.json",
			manifest("@hobo/data-core", ["@hobo/core"]),
		],
		[
			"packages/data-sqlite/package.json",
			manifest("@hobo/data-sqlite", ["@hobo/data-core"]),
		],
		[
			"packages/data-sqlite/src/index.ts",
			'import { DatabaseSync } from "node:sqlite";\nexport const open = (path: string) => new DatabaseSync(path);\n',
		],
		[
			"packages/data-postgres/package.json",
			manifest(
				"@hobo/data-postgres",
				["@hobo/data-core", "pg"],
				["@hobo/data-sqlite"],
			),
		],
		[
			"packages/data-postgres/src/index.ts",
			'import pg from "pg";\nexport const pool = () => new pg.Pool();\n',
		],
		[
			// Test-only: one engine checks itself against another.
			"packages/data-postgres/test/cross-engine.test.ts",
			'import { open } from "@hobo/data-sqlite";\nexport const reference = open;\n',
		],
		[
			"packages/data-mongodb/package.json",
			manifest("@hobo/data-mongodb", ["@hobo/data-core"]),
		],
		[
			"packages/storage-sqlite/package.json",
			manifest("@hobo/storage-sqlite", ["@hobo/core"]),
		],
		[
			"packages/trails/package.json",
			manifest(
				"@hobo/trails",
				["@hobo/data-core"],
				[
					"@hobo/data-sqlite",
					"@hobo/data-postgres",
					"@hobo/data-mongodb",
					"@hobo/storage-sqlite",
					"pg",
					"mongodb",
				],
			),
		],
		[
			// Engines and drivers named in a comment, a string and a template are
			// text, not imports.
			"packages/trails/src/index.ts",
			[
				'import type { Plan } from "@hobo/data-core";',
				'// import { open } from "@hobo/data-sqlite";',
				'/** import { DatabaseSync } from "node:sqlite"; */',
				"export const HINT =",
				"\t'bind an engine: import { open } from \"@hobo/data-sqlite\"';",
				"export const TEMPLATE = `",
				'import { MongoClient } from "mongodb";',
				'const pg = require("pg");',
				'await import("@hobo/storage-sqlite");',
				"`;",
				"export type TrailPlan = Plan;",
				"",
			].join("\n"),
		],
		[
			// A live lane may use every engine and driver there is.
			"packages/trails/test/live.test.ts",
			[
				'import { DatabaseSync } from "node:sqlite";',
				'import { open } from "@hobo/data-sqlite";',
				'import { pool } from "@hobo/data-postgres";',
				'import { MongoClient } from "mongodb";',
				'const storage = await import("@hobo/storage-sqlite");',
				"export const lane = [DatabaseSync, open, pool, MongoClient, storage];",
				"",
			].join("\n"),
		],
	];

	function workspace(extra: readonly (readonly [string, string])[]): string {
		const dir = mkdtempSync(join(tmpdir(), "hobo-boundaries-"));
		workspaces.push(dir);
		for (const [path, content] of [...CLEAN, ...extra]) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
		return dir;
	}

	it("accepts the workspace when engines and drivers are reached from tests only", () => {
		const { status, report, refusals } = run(workspace([]));

		assert.deepEqual(refusals, []);
		assert.equal(status, 0);
		// The clean result is not for want of seeing the packages: the
		// devDependency edges are in the graph, as test-only edges.
		for (const [from, to] of [
			["packages/trails", "packages/data-sqlite"],
			["packages/trails", "pg"],
			["packages/data-postgres", "packages/data-sqlite"],
			["packages/data-sqlite", "node:sqlite"],
		] as const) {
			assert.ok(
				report.edges.some(
					(edge) => edge.from_path === from && edge.to_path === to,
				),
				`expected edge ${from} -> ${to}`,
			);
		}
	});

	it("refuses every way an orchestrator can reach an engine or a driver from src/", () => {
		const { status, refusals } = run(
			workspace([
				[
					// Dynamic import, written as a later argument: the old "is there
					// a quote earlier on this line" guess skipped exactly this.
					"packages/trails/src/registry.ts",
					'export const engines = new Map();\nengines.set("sqlite", () => import("@hobo/data-sqlite"));\n',
				],
				[
					// `require` under another name, through `createRequire`.
					"packages/trails/src/legacy.ts",
					'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const postgres = load("@hobo/data-postgres");\n',
				],
				[
					// Plain `require`, a subpath specifier, and not a `.ts` file.
					"packages/trails/src/compat.cts",
					'const engine = require("@hobo/data-mongodb/engine");\nmodule.exports = engine;\n',
				],
				[
					// The original defect: the builtin driver, imported statically.
					"packages/trails/src/schema-apply.ts",
					'import { DatabaseSync } from "node:sqlite";\nexport const open = (path: string) => new DatabaseSync(path);\n',
				],
				[
					// A driver's subpath, loaded dynamically from a `.mts` file.
					"packages/trails/src/pool.mts",
					'export const pool = async () => (await import("pg/lib/index.js")).Pool;\n',
				],
				[
					// Type-only is still written against the driver.
					"packages/trails/src/dual-port.tsx",
					'import type { MongoClient } from "mongodb";\nexport type Client = MongoClient;\n',
				],
				[
					// Engine-specific storage, re-exported.
					"packages/trails/src/journal.ts",
					'export * from "@hobo/storage-sqlite";\n',
				],
			]),
		);

		assert.deepEqual(
			refusals,
			[
				"orchestrators must not import a data engine at runtime: packages/trails -> packages/data-sqlite",
				"orchestrators must not import a data engine at runtime: packages/trails -> packages/data-postgres",
				"orchestrators must not import a data engine at runtime: packages/trails -> packages/data-mongodb",
				"orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> node:sqlite",
				"orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> pg",
				"orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> mongodb",
				"orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> packages/storage-sqlite",
			].sort(),
		);
		assert.equal(status, 1);
	});

	it("refuses a driver the orchestrator ships as a dependency, imported or not", () => {
		const { status, refusals } = run(
			workspace([
				[
					"packages/trails/package.json",
					manifest("@hobo/trails", ["@hobo/data-core", "better-sqlite3"]),
				],
			]),
		);

		assert.deepEqual(refusals, [
			"orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> better-sqlite3",
		]);
		assert.equal(status, 1);
	});

	it("does not let one unclassifiable import hide the rest of a package's src/", () => {
		// The walk over `src/` sat inside a `try`/`catch` meant for a package
		// with no `src/`. `parseWorkspaceEdge` throws on a workspace path nobody
		// classified, the catch swallowed it, and every file the walk had not
		// reached was never read: here, the engine import in `b.ts`.
		const result = spawnGate(
			workspace([
				[
					"packages/unclassified/package.json",
					manifest("@hobo/unclassified", []),
				],
				["packages/trails/src/a.ts", 'export * from "@hobo/unclassified";\n'],
				["packages/trails/src/b.ts", 'export * from "@hobo/data-sqlite";\n'],
			]),
		);

		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/unknown import target packages\/unclassified/u,
		);
	});

	it("refuses an engine that imports another engine from src/, devDependency or not", () => {
		const { status, refusals } = run(
			workspace([
				[
					"packages/data-postgres/src/fallback.ts",
					'export const fallback = () => import("@hobo/data-sqlite");\n',
				],
			]),
		);

		assert.deepEqual(refusals, [
			"data engines must not import each other at runtime: packages/data-postgres -> packages/data-sqlite",
		]);
		assert.equal(status, 1);
	});
});
