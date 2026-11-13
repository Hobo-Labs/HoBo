import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	mainWorkspaceParallelCap,
	readCommittedRunnerRouting,
} from "../ci/plan-main-workspace-shards.mts";
import { readRunnerRouting } from "../ci/runner-routing.mts";

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
	it("sizes shards from committed routing policy, never from a reading of the fleet or the environment", () => {
		assert.equal(DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP, 4);
		assert.equal(mainWorkspaceParallelCap(undefined), 4);
		const project = JSON.parse(
			readFileSync(join(REPO_ROOT, ".hobo/ci.json"), "utf8"),
		);
		const committed = readRunnerRouting(JSON.stringify(project));
		assert.ok(committed);
		assert.deepEqual(readCommittedRunnerRouting(REPO_ROOT), committed);
		assert.equal(mainWorkspaceParallelCap(committed), 4);
		project.runnerRouting.mainWorkspaceParallelCap = 2;
		assert.equal(
			mainWorkspaceParallelCap(readRunnerRouting(JSON.stringify(project))),
			2,
		);
		// A cap the policy does not allow makes the whole policy invalid: the default.
		for (const value of [0, 9, 2.5, "two"]) {
			project.runnerRouting.mainWorkspaceParallelCap = value;
			assert.equal(
				mainWorkspaceParallelCap(readRunnerRouting(JSON.stringify(project))),
				4,
				String(value),
			);
		}
		assert.equal(
			readCommittedRunnerRouting(join(REPO_ROOT, "nowhere")),
			undefined,
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
		// The retired variable no longer reaches it (plan 0026, R2).
		const capped = plan({ MAIN_WORKSPACE_PARALLEL_CAP: "2" });
		assert.equal(capped.status, 0, `${capped.stdout}\n${capped.stderr}`);
		assert.match(capped.stderr, /parallelCap=4/u);
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
