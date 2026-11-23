import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSurfaceMap, writeSurfaceMap } from "../lib/surface-map.mts";
import { buildExperienceCatalog, writeExperienceCatalog } from "../lib/experience-catalog.mts";
import { runDoctorRepair } from "../lib/doctor.mts";
import { resolveProjects } from "../lib/projects.mts";

const harness = fileURLToPath(new URL("..", import.meta.url));

function fixture(run: (root: string, outside: string) => void): void {
	const base = mkdtempSync(path.join(tmpdir(), "hobo-write-containment-"));
	const root = path.join(base, "repo");
	const outside = path.join(base, "outside");
	mkdirSync(path.join(root, ".git"), { recursive: true });
	mkdirSync(path.join(root, "site"));
	mkdirSync(outside);
	writeFileSync(path.join(root, "site/package.json"), JSON.stringify({ name: "site" }));
	try {
		run(root, outside);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

function invoke(root: string, cli: string, args: string[]) {
	return spawnSync(process.execPath, ["--experimental-strip-types", path.join(harness, `${cli}.mts`), ...args], { cwd: root, encoding: "utf8" });
}

function invokeWorkflow(root: string, cli: string, args: string[]) {
	const workflow = path.join(harness, "../workflows/cross-agent", `${cli}.mts`);
	return spawnSync(process.execPath, ["--experimental-strip-types", workflow, ...args], { cwd: root, encoding: "utf8" });
}

describe("OptimizeXP write containment", () => {
	it("refuses a symlinked scope before any selected or global write", () => {
		fixture((root, outside) => {
			const original = "PRESERVE USER CONTENT\n";
			writeFileSync(path.join(outside, "surface-map.json"), original);
			symlinkSync(outside, path.join(root, "site/.optimizexp"), "dir");
			const commands: [string, string[]][] = [
				["explore-app", ["--project=site"]],
				["capture-evidence", ["--mode=init-feature", "--project=site", "--id=example"]],
				["doctor", ["repair", "--project=site", "--only=ensure-config"]],
				["doctor", ["snapshot", "--project=site"]],
				["init", ["--mode=ensure-config", "--project=site"]],
			];
			for (const [cli, args] of commands) {
				const result = invoke(root, cli, args);
				assert.equal(result.status, 2, `${cli}: ${result.stderr}`);
				assert.match(result.stderr, /Unsafe OptimizeXP write path/);
				assert.equal(readFileSync(path.join(outside, "surface-map.json"), "utf8"), original);
				assert.equal(existsSync(path.join(root, ".optimizexp")), false);
			}
		});
	});

	it("checks the global scope before commands that can write shared metadata", () => {
		fixture((root, outside) => {
			writeFileSync(path.join(outside, "surface-map.json"), "keep global bytes\n");
			symlinkSync(outside, path.join(root, ".optimizexp"), "dir");
			const commands: [string, string[]][] = [
				["explore-app", ["--project=root"]],
				["capture-evidence", ["--mode=init-feature", "--project=site", "--id=example"]],
				["doctor", ["repair", "--project=site", "--only=ensure-config"]],
				["doctor", ["snapshot", "--project=site"]],
				["init", ["--mode=ensure-config", "--project=site"]],
			];
			for (const [cli, args] of commands) {
				const result = invoke(root, cli, args);
				assert.equal(result.status, 2, `${cli}: ${result.stderr}`);
				assert.match(result.stderr, /Unsafe OptimizeXP write path/);
				assert.equal(readFileSync(path.join(outside, "surface-map.json"), "utf8"), "keep global bytes\n");
				assert.equal(existsSync(path.join(root, "site/.optimizexp")), false);
			}
		});
	});

	it("checks every selected scope before a batch writes the first map", () => {
		fixture((root, outside) => {
			const hobo = path.join(root, "packages/hobo/.optimizexp");
			mkdirSync(hobo, { recursive: true });
			writeFileSync(path.join(root, "packages/hobo/package.json"), JSON.stringify({ name: "@hobo/hobo" }));
			writeFileSync(path.join(hobo, "surface-map.json"), "existing first project\n");
			writeFileSync(path.join(outside, "surface-map.json"), "existing outside\n");
			symlinkSync(outside, path.join(root, "site/.optimizexp"), "dir");
			const result = invoke(root, "explore-app", ["--all-projects"]);
			assert.equal(result.status, 2, result.stderr);
			assert.equal(readFileSync(path.join(hobo, "surface-map.json"), "utf8"), "existing first project\n");
			assert.equal(readFileSync(path.join(outside, "surface-map.json"), "utf8"), "existing outside\n");
		});
	});

	it("rejects symlinked leaf files and hard links without changing their targets", () => {
		fixture((root, outside) => {
			const scope = path.join(root, "site/.optimizexp");
			mkdirSync(scope);
			const external = path.join(outside, "retained.txt");
			writeFileSync(external, "do not overwrite\n");
			const target = path.join(scope, "surface-map.json");
			symlinkSync(external, target);
			const project = { id: "site", path: "site", kind: "site" as const, label: "site" };
			const map = buildSurfaceMap({ root, project });
			assert.throws(() => writeSurfaceMap(map, project, root), /symbolic link/);
			assert.throws(() => writeExperienceCatalog(buildExperienceCatalog({ root, project, surfaceMap: map }), project, root), /symbolic link/);
			assert.throws(() => runDoctorRepair({ root, selection: resolveProjects("site", root) }), /symbolic link/);
			assert.equal(invoke(root, "explore-app", ["--project=site"]).status, 2);
			assert.equal(readFileSync(external, "utf8"), "do not overwrite\n");
			rmSync(target);
			symlinkSync(path.join(outside, "missing"), target);
			assert.equal(invoke(root, "explore-app", ["--project=site"]).status, 2);
			rmSync(target);
			linkSync(external, target);
			const hard = invoke(root, "explore-app", ["--project=site"]);
			assert.equal(hard.status, 2, hard.stderr);
			assert.match(hard.stderr, /linked or non-regular file/);
			assert.equal(readFileSync(external, "utf8"), "do not overwrite\n");
		});
	});

	it("protects nested feature and evidence targets before overwrite or deletion", () => {
		fixture((root, outside) => {
			const scope = path.join(root, "site/.optimizexp");
			const feature = path.join(scope, "features/example");
			mkdirSync(path.join(feature, "evidence"), { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "cli", surfaces: [] }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: observed\n    Then status is visible\n");
			writeFileSync(path.join(outside, "primary.txt"), "keep primary\n");
			symlinkSync(outside, path.join(feature, "evidence/observed"), "dir");
			const capture = invoke(root, "capture-evidence", ["--mode=capture", "--project=site", "--feature=example", "--scenario=observed", "--command=printf new"]);
			assert.equal(capture.status, 2, capture.stderr);
			assert.equal(readFileSync(path.join(outside, "primary.txt"), "utf8"), "keep primary\n");
		});
	});

	it("rejects a selected project path that resolves outside the repository", () => {
		fixture((root, outside) => {
			rmSync(path.join(root, "site"), { recursive: true });
			mkdirSync(path.join(outside, ".optimizexp"));
			writeFileSync(path.join(outside, ".optimizexp/surface-map.json"), "keep outside\n");
			symlinkSync(outside, path.join(root, "site"), "dir");
			for (const [cli, args] of [
				["explore-app", ["--project=site"]],
				["doctor", ["repair", "--project=site", "--only=ensure-config"]],
			] as [string, string[]][]) {
				const result = invoke(root, cli, args);
				assert.equal(result.status, 2, `${cli}: ${result.stderr}`);
				assert.equal(readFileSync(path.join(outside, ".optimizexp/surface-map.json"), "utf8"), "keep outside\n");
				assert.equal(existsSync(path.join(root, ".optimizexp")), false);
			}
		});
	});

	it("rejects scope and project aliases to another project inside the repository", () => {
		fixture((root) => {
			const other = path.join(root, "packages/hobo");
			const otherScope = path.join(other, ".optimizexp");
			mkdirSync(otherScope, { recursive: true });
			writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "@hobo/hobo" }));
			writeFileSync(path.join(otherScope, "surface-map.json"), "keep other project\n");
			symlinkSync(otherScope, path.join(root, "site/.optimizexp"), "dir");
			let result = invoke(root, "explore-app", ["--project=site"]);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stderr, /symbolic link/);
			assert.equal(readFileSync(path.join(otherScope, "surface-map.json"), "utf8"), "keep other project\n");
			rmSync(path.join(root, "site"), { recursive: true });
			symlinkSync(other, path.join(root, "site"), "dir");
			for (const [cli, args] of [
				["explore-app", ["--project=site"]],
				["doctor", ["repair", "--project=site", "--only=ensure-config"]],
			] as [string, string[]][]) {
				result = invoke(root, cli, args);
				assert.equal(result.status, 2, `${cli}: ${result.stderr}`);
				assert.match(result.stderr, /symbolic link/);
				assert.equal(readFileSync(path.join(otherScope, "surface-map.json"), "utf8"), "keep other project\n");
				assert.equal(existsSync(path.join(root, ".optimizexp")), false);
			}
		});
	});

	it("permits ordinary in-repository scope creation and updates", () => {
		fixture((root) => {
			const result = invoke(root, "explore-app", ["--project=site"]);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(existsSync(path.join(root, "site/.optimizexp/surface-map.json")), true);
			const config = invoke(root, "init", ["--mode=ensure-config", "--project=site"]);
			assert.equal(config.status, 0, config.stderr);
			assert.equal(existsSync(path.join(root, "site/.optimizexp/config.json")), true);
		});
	});

	it("also protects global paths used by evidence posting", () => {
		fixture((root, outside) => {
			mkdirSync(path.join(root, ".optimizexp"));
			writeFileSync(path.join(outside, "sentinel"), "keep workflow bytes\n");
			symlinkSync(outside, path.join(root, ".optimizexp/runs"), "dir");
			const results = [
				invoke(root, "post-pr-evidence", ["--feature", "example", "--pr", "1"]),
			];
			for (const result of results) {
				assert.equal(result.status, 2, `${result.stdout} ${result.stderr}`);
				assert.match(`${result.stdout} ${result.stderr}`, /Unsafe OptimizeXP write path/);
			}
			assert.equal(readFileSync(path.join(outside, "sentinel"), "utf8"), "keep workflow bytes\n");
			assert.equal(existsSync(path.join(outside, "example")), false);
		});
	});

	it("rejects path-like workflow identifiers before writing", () => {
		fixture((root, outside) => {
			const invalidReview = invokeWorkflow(root, "review-loop", ["--mode", "init", "--run", "../../outside"]);
			assert.equal(invalidReview.status, 2, invalidReview.stderr);
			const invalidCouncil = invokeWorkflow(root, "consensus-loop", ["--mode", "status", "--run", "..", "--review", "example"]);
			assert.equal(invalidCouncil.status, 2, invalidCouncil.stdout);
			assert.match(invalidCouncil.stdout, /unsafe-id/);
			assert.equal(existsSync(path.join(outside, "scope.json")), false);
		});
	});

	it("does not compress evidence or create a run directory during a posting dry run", () => {
		fixture((root) => {
			const evidence = path.join(root, ".optimizexp/features/example/evidence/observed");
			mkdirSync(evidence, { recursive: true });
			writeFileSync(path.join(evidence, "manifest.json"), JSON.stringify({ primaryPath: "primary.png", kind: "png" }));
			const bytes = Buffer.alloc(1_000_001);
			writeFileSync(path.join(evidence, "primary.png"), bytes);
			writeFileSync(path.join(evidence, "meta.json"), JSON.stringify({ primary: { file: "primary.png", kind: "png", sha256: createHash("sha256").update(bytes).digest("hex") } }));
			const result = invoke(root, "post-pr-evidence", ["--feature", "example", "--pr", "1", "--dry-run"]);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(existsSync(path.join(root, ".optimizexp/runs")), false);
		});
	});

	it("rejects unrecognized posting options before side effects", () => {
		fixture((root) => {
			const results = [
				invoke(root, "post-pr-evidence", ["--feature", "example", "--pr", "1", "--dryrun"]),
			];
			for (const result of results) {
				assert.equal(result.status, 2, `${result.stdout} ${result.stderr}`);
				assert.match(`${result.stdout} ${result.stderr}`, /Unknown option: --dryrun/);
				assert.equal(existsSync(path.join(root, ".optimizexp")), false);
			}
		});
	});
});
