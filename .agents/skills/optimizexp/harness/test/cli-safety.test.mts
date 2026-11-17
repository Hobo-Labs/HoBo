import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildExperienceCatalog, writeExperienceCatalog } from "../lib/experience-catalog.mts";
import { buildSurfaceMap, writeSurfaceMap } from "../lib/surface-map.mts";
import { resolveProjects } from "../lib/projects.mts";

const harness = fileURLToPath(new URL("..", import.meta.url));

function fixture(run: (root: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-cli-safety-"));
	mkdirSync(path.join(root, ".git"));
	mkdirSync(path.join(root, "site"));
	mkdirSync(path.join(root, "packages/hobo"), { recursive: true });
	writeFileSync(path.join(root, "packages/hobo/package.json"), JSON.stringify({ name: "@hobo/hobo", scripts: { start: "node server.js" } }));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function invoke(root: string, cli: string, args: string[]) {
	return spawnSync(process.execPath, ["--experimental-strip-types", path.join(harness, `${cli}.mts`), ...args], { cwd: root, encoding: "utf8" });
}

function snapshot(root: string): string[] {
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			const rel = path.relative(root, file);
			if (entry.isDirectory()) {
				files.push(`dir:${rel}`);
				visit(file);
			} else {
				files.push(`file:${rel}:${readFileSync(file).toString("base64")}`);
			}
		}
	};
	visit(root);
	return files.sort();
}

describe("project selection and write safety", () => {
	it("refuses unknown, mixed, malformed, missing, and misspelled selectors before every mutating entrypoint", () => {
		fixture((root) => {
			const cases: [string, string[]][] = [
				["explore-app", ["--mode=explore"]],
				["generate-feature", ["--mode=plan", "--id=sample", "--seed=sample"]],
				["generate-persona", ["--mode=scaffold", "--id=sample", "--seed=sample"]],
				["capture-evidence", ["--mode=init-feature", "--id=sample"]],
				["doctor", ["repair", "--only=ensure-config"]],
				["doctor", ["snapshot"]],
				["init", ["--mode=ensure-config"]],
			];
			const selectors = [
				["--project", "code"], ["--project=code"], ["--project=site,code"],
				["--project=all,code"], ["--project=../../site"], ["--project=/site"],
				["--all-projects", "--project=code"], ["--project"], ["--project="], ["--projec=site"],
			];
			const before = snapshot(root);
			for (const [cli, args] of cases) {
				for (const selector of selectors) {
					const result = invoke(root, cli, [...args, ...selector]);
					assert.equal(result.status, 2, `${cli} ${selector.join(" ")}: ${result.stderr}`);
					assert.deepEqual(snapshot(root), before, `${cli} ${selector.join(" ")} wrote files`);
				}
			}
		});
	});

	it("recognizes equals-form modes and refuses unknown modes without writes", () => {
		fixture((root) => {
			const before = snapshot(root);
			const explore = invoke(root, "explore-app", ["--mode=validate", "--project=site"]);
			assert.equal(explore.status, 1, explore.stderr);
			assert.deepEqual(snapshot(root), before);
			const feature = invoke(root, "generate-feature", ["--mode=validate", "--project=site", "--id=missing", "--seed=ignored"]);
			assert.notEqual(feature.status, null);
			assert.deepEqual(snapshot(root), before);
			for (const cli of ["explore-app", "generate-feature", "generate-persona", "capture-evidence", "doctor", "init"]) {
				const result = invoke(root, cli, ["--mode=unexpected", "--project=site"]);
				assert.equal(result.status, 2, `${cli}: ${result.stderr}`);
				assert.deepEqual(snapshot(root), before);
			}
		});
	});

	it("rejects unsupported positionals before writes while retaining mode and seed positionals", () => {
		fixture((root) => {
			const before = snapshot(root);
			const invalid: [string, string[]][] = [
				["explore-app", ["code"]],
				["doctor", ["repair", "code", "--only", "ensure-config"]],
				["doctor", ["--mode=repair", "check", "--only=ensure-config"]],
				["init", ["ensure-config", "code"]],
				["capture-evidence", ["init-feature", "code", "--id=sample"]],
				["capture-evidence", ["--mode=init-feature", "validate", "--id=sample"]],
				["generate-feature", ["--mode=from-catalog", "code"]],
				["generate-feature", ["--mode=plan", "one", "two"]],
				["generate-feature", ["--mode=plan", "--seed=one", "two"]],
				["generate-persona", ["--mode=validate", "code"]],
				["generate-persona", ["--seed=one", "two"]],
			];
			for (const [cli, args] of invalid) {
				const result = invoke(root, cli, args);
				assert.equal(result.status, 2, `${cli} ${args.join(" ")}: ${result.stderr}`);
				assert.deepEqual(snapshot(root), before, `${cli} ${args.join(" ")} wrote files`);
			}
			const doctor = invoke(root, "doctor", ["check", "--project=root", "--json"]);
			assert.equal(doctor.status, 1, doctor.stderr);
			assert.match(doctor.stdout, /"mode": "check"/);
			const init = invoke(root, "init", ["list-projects"]);
			assert.equal(init.status, 0, init.stderr);
			const capture = invoke(root, "capture-evidence", ["validate"]);
			assert.equal(capture.status, 0, capture.stderr);
			const feature = invoke(root, "generate-feature", ["--mode=plan", "Inspect a feature", "--project=root", "--dry-run"]);
			assert.equal(feature.status, 0, feature.stderr);
			assert.match(feature.stdout, /"dryRun": true/);
			const persona = invoke(root, "generate-persona", ["Inspect spending", "--project=root", "--dry-run"]);
			assert.equal(persona.status, 0, persona.stderr);
			assert.deepEqual(snapshot(root), before);
		});
	});

	it("retains valid all, root, scoped-package and existing-project selection", () => {
		fixture((root) => {
			assert.equal(resolveProjects("all", root).allProjects, true);
			assert.deepEqual(resolveProjects("root", root).projects.map((project) => project.id), ["root"]);
			assert.deepEqual(resolveProjects("@hobo/hobo", root).projects.map((project) => project.id), ["hobo"]);
			assert.deepEqual(resolveProjects("packages/hobo", root).projects.map((project) => project.id), ["hobo"]);
			assert.deepEqual(resolveProjects("site,hobo", root).unknown, []);
			assert.ok(resolveProjects("../../site", root).unknown.length);
			const dry = invoke(root, "generate-feature", ["--mode=plan", "--project=root", "--id=planned", "--seed=sample", "--dry-run"]);
			assert.equal(dry.status, 0, dry.stderr);
			assert.equal(existsSync(path.join(root, ".optimizexp")), false);
			const all = invoke(root, "generate-feature", ["--mode=plan", "--all-projects", "--id=planned", "--seed=sample", "--dry-run"]);
			assert.equal(all.status, 0, all.stderr);
			const allPersona = invoke(root, "generate-persona", ["--all-projects", "--id=reader", "--seed=reader", "--dry-run"]);
			assert.equal(allPersona.status, 0, allPersona.stderr);
			const allCapture = invoke(root, "capture-evidence", ["--mode=validate", "--all-projects"]);
			assert.equal(allCapture.status, 0, allCapture.stderr);
			const allExplore = invoke(root, "explore-app", ["--mode=validate", "--all-projects"]);
			assert.equal(allExplore.status, 1, allExplore.stderr);
			assert.equal(existsSync(path.join(root, ".optimizexp")), false);
			const noConfig = invoke(root, "init", ["--mode=ensure-config", "--project=root", "--dry-run"]);
			assert.equal(noConfig.status, 2, noConfig.stderr);
			assert.equal(existsSync(path.join(root, ".optimizexp")), false);
		});
	});

	it("preserves every existing evidence artifact for invalid selectors and capture inputs", () => {
		fixture((root) => {
			const feature = path.join(root, ".optimizexp/features/example");
			const evidence = path.join(feature, "evidence/observed");
			mkdirSync(evidence, { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "cli", surfaces: [] }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: observed\n    Then evidence exists\n");
			for (const name of ["primary.txt", "manifest.json", "meta.json", "review.json", "REPLAY.md", "_handoff.sh"]) {
				writeFileSync(path.join(evidence, name), `preserve ${name}\n`);
			}
			const before = snapshot(root);
			const invalid = [
				["--project=code"], ["--project=root", "--driver=cli"],
				["--project=root", "--driver=tui"], ["--project=root", "--driver=web", "--url=not-a-url"],
				["--project=root", "--driver=unknown"], ["--project=root", "--scenario=../../outside", "--command=printf safe"],
			];
			for (const args of invalid) {
				const result = invoke(root, "capture-evidence", ["--mode=capture", "--feature=example", "--scenario=observed", ...args]);
				assert.equal(result.status, 2, result.stderr);
				assert.deepEqual(snapshot(root), before, `capture ${args.join(" ")} changed evidence`);
			}
		});
	});

	it("rejects path-like feature identifiers before creating or replacing files", () => {
		fixture((root) => {
			const before = snapshot(root);
			for (const id of ["../../escape", "/tmp/escape", "nested/feature", "nested\\feature"]) {
				const plan = invoke(root, "generate-feature", ["--mode=plan", "--project=root", `--id=${id}`, "--seed=sample"]);
				assert.equal(plan.status, 2, plan.stderr);
				const capture = invoke(root, "capture-evidence", ["--mode=init-feature", "--project=root", `--id=${id}`]);
				assert.equal(capture.status, 2, capture.stderr);
				assert.deepEqual(snapshot(root), before);
			}
		});
	});

	it("captures only the selected project's same-named feature and claims", () => {
		fixture((root) => {
			for (const projectPath of ["site", "packages/hobo"]) {
				const feature = path.join(root, projectPath, ".optimizexp/features/example");
				const evidence = path.join(feature, "evidence/observed");
				mkdirSync(evidence, { recursive: true });
				writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", driver: "cli", surfaces: [] }));
				writeFileSync(path.join(feature, "example.feature"), `Feature: Example\n  Scenario: observed\n    Then ${projectPath} is visible\n`);
				writeFileSync(path.join(evidence, "primary.txt"), `original ${projectPath}\n`);
			}
			const other = path.join(root, "packages/hobo/.optimizexp/features/example/evidence/observed/primary.txt");
			const before = readFileSync(other);
			const result = invoke(root, "capture-evidence", ["--mode=capture", "--project=site", "--feature=example", "--scenario=observed", "--command=printf site"]);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(readFileSync(other), before);
			const meta = readFileSync(path.join(root, "site/.optimizexp/features/example/evidence/observed/meta.json"), "utf8");
			assert.match(meta, /Then site is visible/);
			assert.doesNotMatch(meta, /Then packages\/hobo is visible/);
		});
	});

	it("does not implement a different project's feature or write in implement dry-run", () => {
		fixture((root) => {
			const feature = path.join(root, "packages/hobo/.optimizexp/features/example");
			mkdirSync(feature, { recursive: true });
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example", surfaces: [] }));
			const before = snapshot(root);
			const other = invoke(root, "generate-feature", ["--mode=implement", "--project=site", "--id=example"]);
			assert.equal(other.status, 2, other.stderr);
			const dry = invoke(root, "generate-feature", ["--mode=implement", "--project=hobo", "--id=example", "--dry-run"]);
			assert.equal(dry.status, 2, dry.stderr);
			assert.deepEqual(snapshot(root), before);
		});
	});

	it("keeps a catalog dry-run from changing an existing EXPERIENCE.md", () => {
		fixture((root) => {
			const project = { id: "hobo", path: "packages/hobo", kind: "package" as const, label: "hobo" };
			const personaDir = path.join(root, ".optimizexp/personas");
			mkdirSync(personaDir, { recursive: true });
			writeFileSync(path.join(personaDir, "developer.md"), "---\nid: developer\nexperiences: [dx]\ninterfaces: [cli]\n---\nUses the app.\n");
			const map = buildSurfaceMap({ project, root });
			const catalog = buildExperienceCatalog({ project, root, personaIds: ["developer"], surfaceMap: map });
			catalog.experiences.push({ experienceId: "script-start", featureId: "script-start", personaId: "developer", intent: "Start the app", entryCommand: "npm run start", driver: "cli", observableSuccess: "The app starts", observableFailure: "The app fails", confusionRisks: [], priority: "P0", source: ["README"] });
			writeSurfaceMap(map, project, root);
			writeExperienceCatalog(catalog, project, root);
			const featureDir = path.join(root, project.path, ".optimizexp/features/script-start");
			mkdirSync(featureDir, { recursive: true });
			writeFileSync(path.join(featureDir, "EXPERIENCE.md"), "TODO\n- [ ] Check\n- accept | revise | reject\n");
			const before = snapshot(root);
			const result = invoke(root, "generate-feature", ["--mode=from-catalog", "--project=hobo", "--personas=developer", "--force-low-quality", "--dry-run"]);
			assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
			assert.deepEqual(snapshot(root), before);
			const alias = invoke(root, "generate-feature", ["--from-catalog", "--project=hobo", "--personas=developer", "--force-low-quality", "--dry-run"]);
			assert.equal(alias.status, 0, `${alias.stderr}\n${alias.stdout}`);
			assert.match(alias.stdout, /"mode": "from-catalog"/);
			assert.deepEqual(snapshot(root), before);
			const conflict = invoke(root, "generate-feature", ["--mode=plan", "--from-catalog", "--project=hobo", "--id=another", "--seed=sample"]);
			assert.equal(conflict.status, 2, conflict.stderr);
			assert.deepEqual(snapshot(root), before);
			const write = invoke(root, "generate-feature", ["--from-catalog", "--project=hobo", "--personas=developer", "--force-low-quality"]);
			assert.equal(write.status, 0, `${write.stderr}\n${write.stdout}`);
			const generated = JSON.parse(readFileSync(path.join(featureDir, "feature.json"), "utf8")) as { catalogOrigin?: { entryCommand?: string } };
			assert.equal(generated.catalogOrigin?.entryCommand, "npm run start");
		});
	});

	it("rejects a path-like catalog feature before writing any valid sibling", () => {
		fixture((root) => {
			const project = { id: "hobo", path: "packages/hobo", kind: "package" as const, label: "hobo" };
			const personaDir = path.join(root, ".optimizexp/personas");
			mkdirSync(personaDir, { recursive: true });
			writeFileSync(path.join(personaDir, "developer.md"), "---\nid: developer\nexperiences: [dx]\ninterfaces: [cli]\n---\nUses the app.\n");
			const map = buildSurfaceMap({ project, root });
			const catalog = buildExperienceCatalog({ project, root, personaIds: ["developer"], surfaceMap: map });
			const common = { personaId: "developer", intent: "Start", entryCommand: "npm run start", driver: "cli" as const, observableSuccess: "Starts", observableFailure: "Fails", confusionRisks: [], priority: "P0" as const, source: ["README"] };
			catalog.experiences.push({ ...common, experienceId: "valid", featureId: "valid" });
			catalog.experiences.push({ ...common, experienceId: "escape", featureId: "../../escape" });
			writeSurfaceMap(map, project, root);
			writeExperienceCatalog(catalog, project, root);
			const before = snapshot(root);
			const result = invoke(root, "generate-feature", ["--mode=from-catalog", "--project=hobo", "--personas=developer", "--force-low-quality"]);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stderr, /Invalid feature id/);
			assert.deepEqual(snapshot(root), before);
		});
	});
});
