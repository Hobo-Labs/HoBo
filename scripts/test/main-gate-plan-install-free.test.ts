import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	mainWorkspaceParallelCap,
} from "../ci/plan-main-workspace-shards.mts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS_CI = join(REPO_ROOT, "scripts", "ci");

const IMPORT_PATTERN =
	/^\s*import\s+(?:type\s+)?(?:[\w*{}\s$,]+\s+from\s+)?["']([^"']+)["']/gm;

function collectRelativeCiModules(
	entry: string,
	seen = new Set<string>(),
): string[] {
	const absolute = resolve(entry);
	if (seen.has(absolute)) return [...seen];
	seen.add(absolute);
	const source = readFileSync(absolute, "utf8");
	for (const match of source.matchAll(IMPORT_PATTERN)) {
		const specifier = match[1];
		if (specifier === undefined) continue;
		if (specifier.startsWith("node:")) continue;
		if (!specifier.startsWith(".")) {
			throw new Error(`${absolute} imports non-builtin package ${specifier}`);
		}
		const next = fileURLToPath(
			new URL(specifier, pathToFileURL(`${dirname(absolute)}/`)),
		);
		void collectRelativeCiModules(next, seen);
	}
	return [...seen];
}

function plan(env: Record<string, string>) {
	return spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			"scripts/ci/plan-main-workspace-shards.mts",
		],
		{
			cwd: REPO_ROOT,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				EVENT_NAME: "workflow_dispatch",
				...env,
			},
			encoding: "utf8",
		},
	);
}

describe("main-gate-plan install-free", () => {
	it("sizes shards from its own setting, never from a reading of the fleet", () => {
		assert.equal(DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP, 4);
		assert.equal(mainWorkspaceParallelCap({}), 4);
		assert.equal(
			mainWorkspaceParallelCap({ MAIN_WORKSPACE_PARALLEL_CAP: "2" }),
			2,
		);
		for (const value of ["", "0", "9", "2.5", "two"])
			assert.equal(
				mainWorkspaceParallelCap({ MAIN_WORKSPACE_PARALLEL_CAP: value }),
				4,
				value,
			);
		// What a worker once published reaches it no more (rule R2).
		assert.equal(
			mainWorkspaceParallelCap({
				HOBO_CI_FLEET_CAPACITY_JSON: JSON.stringify({
					version: 1,
					admittedParallel: 1,
				}),
			}),
			4,
		);
	});

	it("loads only builtins on the plan-main-workspace-shards dependency graph, and no capacity reader", () => {
		assert.ok(!existsSync(join(SCRIPTS_CI, "load-fleet-capacity.mts")));
		const entry = join(SCRIPTS_CI, "plan-main-workspace-shards.mts");
		const modules = collectRelativeCiModules(entry);
		for (const path of modules) {
			const source = readFileSync(path, "utf8");
			assert.doesNotMatch(source, /HOBO_CI_FLEET_CAPACITY/u, path);
			for (const match of source.matchAll(IMPORT_PATTERN)) {
				const specifier = match[1];
				if (specifier === undefined) continue;
				assert.ok(
					specifier.startsWith("node:") || specifier.startsWith("."),
					`${path} imports ${specifier}`,
				);
			}
		}
	});

	it("runs plan-main-workspace-shards without resolving workspace node_modules", () => {
		const capped = plan({ MAIN_WORKSPACE_PARALLEL_CAP: "2" });
		assert.equal(capped.status, 0, `${capped.stdout}\n${capped.stderr}`);
		assert.match(capped.stderr, /parallelCap=2/u);
		const unset = plan({
			HOBO_CI_FLEET_CAPACITY_JSON: JSON.stringify({
				version: 1,
				admittedParallel: 2,
				hobo: { freeSlots: 2 },
				arc: { freeSlots: 0 },
			}),
		});
		assert.equal(unset.status, 0, `${unset.stdout}\n${unset.stderr}`);
		assert.match(unset.stderr, /parallelCap=4/u);
	});
});
