import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(skillRoot, "../../..");
const reviewLoop = path.join(skillRoot, "workflows/cross-agent/review-loop.mts");

function runRl(root: string, args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", reviewLoop, "--root", root, ...args], { cwd: repoRoot, encoding: "utf8" });
  return { code: result.status, json: result.stdout ? JSON.parse(result.stdout) : {}, stdout: result.stdout + result.stderr };
}

function seedRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oxp-history-"));
  mkdirSync(path.join(dir, ".optimizexp/bus/entries"), { recursive: true });
  mkdirSync(path.join(dir, ".git"));
  return dir;
}

function seedRun(root: string, runId: string, projects: string[] = []): void {
  const dir = path.join(root, ".optimizexp/runs", runId);
  mkdirSync(path.join(dir, "iterations"), { recursive: true });
  writeFileSync(path.join(dir, "scope.json"), JSON.stringify({ runId, experiences: ["dx"], personas: [], features: [], projects, surfaces: [], reportOnly: false, passes: null, cyclesCompleted: 0, passesCompleted: 0, status: "running", regime: "harm_reduce", regimesEntered: ["harm_reduce"], stopPolicy: "infinite-until-pareto-equilibrium", noDelight: false, noSurvey: false, delightPasses: null, delightCyclesCompleted: 0, surveyCompleted: false }));
}

describe("historical review validation", () => {
it("copied scores from baseline fail without justification", () => {
		const dir = seedRepo();
		const run = "t-copied";
		try {
			seedRun(dir, run);
			const runDir = path.join(dir, ".optimizexp/runs", run);
			const payload = {
				iteration: 0,
				cells: [
					{
						persona: "dev",
						surface: "cli",
						harms: 1,
						friction: 2,
						uncertainty: 0,
					},
				],
				metric_total: 3,
				metric_max: 2,
			};
			writeFileSync(
				path.join(runDir, "baseline.json"),
				JSON.stringify({ runId: run, ...payload }) + "\n",
			);
			mkdirSync(path.join(runDir, "iterations/000"), { recursive: true });
			writeFileSync(
				path.join(runDir, "iterations/000/scores.json"),
				JSON.stringify(payload) + "\n",
			);
			const copied = runRl(dir, ["--mode", "assert-complete", "--run", run]);
			assert.notEqual(copied.code, 0);
			const missing = copied.json.missing as string[];
			assert.ok(
				missing.some((m) =>
					m.includes(
						"copied_scores_without_justification:iterations/000/scores.json",
					),
				),
				JSON.stringify(missing),
			);

			writeFileSync(
				path.join(runDir, "iterations/000/scores.json"),
				JSON.stringify({
					...payload,
					justification: "no product change since baseline; re-measure pending",
				}) + "\n",
			);
			const justified = runRl(dir, ["--mode", "assert-complete", "--run", run]);
			assert.notEqual(justified.code, 0);
			assert.ok(
				!(justified.json.missing as string[]).some((m) =>
					m.includes("copied_scores_without_justification"),
				),
			);

			writeFileSync(
				path.join(runDir, "iterations/000/scores.json"),
				JSON.stringify({ ...payload, metric_total: 2, metric_max: 1 }) + "\n",
			);
			const reMeasured = runRl(dir, ["--mode", "assert-complete", "--run", run]);
			assert.ok(
				!(reMeasured.json.missing as string[]).some((m) =>
					m.includes("copied_scores_without_justification"),
				),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

it("assert-complete fails on empty / product-only run", () => {
		const dir = seedRepo();
		try {
			seedRun(dir, "t-empty");
			const { code, json } = runRl(dir, [
				"--mode",
				"assert-complete",
				"--run",
				"t-empty",
			]);
			assert.notEqual(code, 0);
			assert.equal(json.ok, false);
			const missing = json.missing as string[];
			assert.ok(missing.includes("no_iterations"));
			assert.ok(missing.includes("bus_complete_triples_lt_1"));
			assert.ok(missing.includes("delight_regime_never_entered"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

it("mutating completion requires a verified experiment and feature coverage", () => {
		const dir = seedRepo();
		try {
			seedRun(dir, "t-required");
			const result = runRl(dir, ["--mode", "assert-complete", "--run", "t-required"]);
			assert.notEqual(result.code, 0);
			assert.match(result.stdout, /verified_experiment_missing/);
			assert.match(result.stdout, /feature_coverage_missing/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

it("surface maps resolve through the project registry", () => {
		const dir = seedRepo();
		try {
			mkdirSync(path.join(dir, "examples/demo/.optimizexp"), { recursive: true });
			writeFileSync(path.join(dir, "examples/demo/package.json"), '{"name":"demo"}\n');
			writeFileSync(path.join(dir, "examples/demo/.optimizexp/surface-map.json"), "{}\n");
			seedRun(dir, "t-map", ["demo"]);
			const result = runRl(dir, ["--mode", "assert-complete", "--run", "t-map"]);
			assert.doesNotMatch(result.stdout, /surface_map_missing:demo/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

it("foreign bus entries cannot satisfy a run", () => {
		const dir = seedRepo();
		try {
			seedRun(dir, "t-isolated");
			writeFileSync(path.join(dir, ".optimizexp/bus/entries/foreign.json"), JSON.stringify({
				kind: "expect", id: "foreign-expect", runId: "other-run",
			}) + "\n");
			const result = runRl(dir, ["--mode", "assert-complete", "--run", "t-isolated"]);
			assert.notEqual(result.code, 0);
			assert.match(result.stdout, /bus_complete_triples_lt_1/);
			assert.match(result.stdout, /verified_experiment_missing/);
			assert.doesNotMatch(result.stdout, /runId_mismatch/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
