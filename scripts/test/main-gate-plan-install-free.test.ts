import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	parseFleetCapacityPublished,
	resolveMainWorkspaceParallelCap,
} from "../ci/load-fleet-capacity.mts";

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

describe("main-gate-plan install-free", () => {
	it("parses fleet capacity JSON without workspace packages", () => {
		assert.equal(parseFleetCapacityPublished(""), undefined);
		assert.equal(parseFleetCapacityPublished("not-json"), undefined);
		const parsed = parseFleetCapacityPublished(
			'{"version":1,"admittedParallel":2,"hobo":{"freeSlots":2},"arc":{"freeSlots":0}}',
		);
		assert.equal(parsed?.admittedParallel, 2);
	});

	it("defaults parallel cap to 4 when capacity is missing or invalid", async () => {
		const prior = process.env.HOBO_CI_FLEET_CAPACITY_JSON;
		delete process.env.HOBO_CI_FLEET_CAPACITY_JSON;
		delete process.env.MAIN_WORKSPACE_PARALLEL_CAP;
		try {
			assert.equal(
				await resolveMainWorkspaceParallelCap({}),
				DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
			);
			process.env.HOBO_CI_FLEET_CAPACITY_JSON = '{"version":99}';
			assert.equal(
				await resolveMainWorkspaceParallelCap({}),
				DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
			);
		} finally {
			if (prior === undefined) delete process.env.HOBO_CI_FLEET_CAPACITY_JSON;
			else process.env.HOBO_CI_FLEET_CAPACITY_JSON = prior;
		}
	});

	it("loads only builtins on the plan-main-workspace-shards dependency graph", () => {
		const entry = join(SCRIPTS_CI, "plan-main-workspace-shards.mts");
		const modules = collectRelativeCiModules(entry);
		assert.ok(modules.some((path) => path.endsWith("load-fleet-capacity.mts")));
		for (const path of modules) {
			const source = readFileSync(path, "utf8");
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
		const result = spawnSync(
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
					HOBO_CI_FLEET_CAPACITY_JSON: JSON.stringify({
						version: 1,
						admittedParallel: 2,
						hobo: { freeSlots: 2 },
						arc: { freeSlots: 0 },
						publishedAt: new Date().toISOString(),
					}),
				},
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /parallelCap=2/u);
	});
});
