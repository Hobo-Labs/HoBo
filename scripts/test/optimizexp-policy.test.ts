import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod";
import { test } from "node:test";

const tsx = resolve("node_modules/.bin/tsx");

for (const harness of [".agents", ".claude"]) {
	const scripts = resolve(`${harness}/skills/optimizexp/harness`);

	test(`${harness} refuses synthetic scaffolds and backlogs before writing`, () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-oxp-policy-"));
		try {
			mkdirSync(join(directory, ".git"));
			for (const [script, ...args] of [
				["init.mts"],
				["generate-persona.mts", "--seed", "Developer"],
				["generate-feature.mts", "--seed", "Use the application"],
				[
					"generate-feature.mts",
					"--mode",
					"plan",
					"--seed",
					"Use the application",
				],
				[
					"generate-feature.mts",
					"--mode",
					"from-catalog",
					"--force-low-quality",
				],
				["explore-app.mts", "--mode", "catalog", "--project", "example"],
				["explore-app.mts", "--with-catalog", "--project", "example"],
				["survey.mts", "--mode", "template", "--run", "example"],
				[
					"survey.mts",
					"--mode",
					"rank-backlog",
					"--run",
					"example",
					"--global",
				],
			]) {
				assert(script);
				const result = spawnSync(tsx, [join(scripts, script), ...args], {
					cwd: directory,
					encoding: "utf8",
				});
				assert.notEqual(result.status, 0, `${script} ${args.join(" ")}`);
				assert.equal(existsSync(join(directory, ".optimizexp")), false);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test(`${harness} validates implemented bindings without requiring plans`, () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-oxp-feature-"));
		try {
			mkdirSync(join(directory, ".git"));
			const feature = join(directory, ".optimizexp/features/example");
			const steps = join(feature, "steps");
			mkdirSync(steps, { recursive: true });
			mkdirSync(join(feature, "test"));
			writeFileSync(
				join(feature, "feature.json"),
				'{"id":"example","personas":["visitor"]}\n',
			);
			writeFileSync(
				join(feature, "example-visitor.feature"),
				"@optimizexp @persona:visitor @interface:web\nFeature: example\n  Scenario: start\n    When I open `/`\n    Then I see the application\n  Scenario: return\n    When I open `/`\n    Then I see the application\n",
			);
			for (const name of ["bindings.steps.ts", "world.ts", "discovery.json"]) {
				writeFileSync(
					join(steps, name),
					name.endsWith(".json") ? '{"bindings":[]}\n' : "export {};\n",
				);
			}
			writeFileSync(
				join(feature, "test/example.bindings.test.ts"),
				"export {};\n",
			);
			const implementation = join(steps, "implementations.ts");
			writeFileSync(
				implementation,
				'export const status = { criticalPath: "stub" };\n',
			);
			const validate = () =>
				spawnSync(
					tsx,
					[
						join(scripts, "generate-feature.mts"),
						"--mode",
						"validate",
						"--id",
						"example",
					],
					{ cwd: directory, encoding: "utf8" },
				);
			const unfinished = validate();
			assert.equal(unfinished.status, 1, unfinished.stderr);
			assert.match(unfinished.stdout, /unimplemented step bindings/u);
			writeFileSync(
				implementation,
				'export const status = { criticalPath: "wired" };\n',
			);
			const finished = validate();
			assert.equal(finished.status, 0, finished.stderr || finished.stdout);
			assert.equal(existsSync(join(feature, "EXPERIENCE.md")), false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test(`${harness} doctor does not fabricate missing review documents`, () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-oxp-doctor-"));
		try {
			mkdirSync(join(directory, ".git"));
			const feature = join(directory, ".optimizexp/features/example");
			mkdirSync(feature, { recursive: true });
			writeFileSync(join(feature, "feature.json"), '{"id":"example"}\n');
			const result = spawnSync(
				tsx,
				[
					join(scripts, "doctor.mts"),
					"repair",
					"--only",
					"feature-experience",
					"--json",
				],
				{ cwd: directory, encoding: "utf8" },
			);
			assert(result.stdout, result.stderr);
			const report = z
				.object({ repairsApplied: z.array(z.string()) })
				.parse(JSON.parse(result.stdout));
			assert.deepEqual(report.repairsApplied, []);
			assert.equal(existsSync(join(feature, "EXPERIENCE.md")), false);
			assert.equal(
				readFileSync(join(feature, "feature.json"), "utf8"),
				'{"id":"example"}\n',
			);
			writeFileSync(join(feature, "EXPERIENCE.md"), "existing review plan\n");
			writeFileSync(join(feature, "SEED.md"), "existing seed\n");
			writeFileSync(join(directory, ".optimizexp/INIT.md"), "existing plan\n");
			writeFileSync(
				join(directory, ".optimizexp/experience-catalog.json"),
				"{}\n",
			);
			const snapshot = join(directory, "snapshot");
			const snapshotResult = spawnSync(
				tsx,
				[join(scripts, "doctor.mts"), "snapshot", "--out", snapshot, "--json"],
				{ cwd: directory, encoding: "utf8" },
			);
			assert(snapshotResult.stdout, snapshotResult.stderr);
			const manifest = z
				.object({ files: z.array(z.object({ rel: z.string() })) })
				.parse(
					JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8")),
				);
			const copied = manifest.files.map((file) => file.rel);
			assert(copied.includes(".optimizexp/features/example/feature.json"));
			assert(
				copied.every(
					(file) =>
						!/EXPERIENCE\.md|SEED\.md|INIT\.md|experience-catalog\.json/u.test(
							file,
						),
				),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
