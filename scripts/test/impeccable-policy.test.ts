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
import { test } from "node:test";
import { pathToFileURL } from "node:url";

for (const harness of [".agents", ".claude", ".cursor", ".github"]) {
	test(`${harness} visual skill uses source context and refuses planning files`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-visual-policy-"));
		try {
			const skill = resolve(`${harness}/skills/impeccable`);
			const instructions = readFileSync(join(skill, "SKILL.md"), "utf8");
			assert.match(
				instructions,
				/Follow the repository rules in `AGENTS\.md`/u,
			);
			assert.match(
				instructions,
				/Do not create planning documents, design documents/u,
			);
			const scripts = join(skill, "scripts");
			const body = join(directory, "body.txt");
			writeFileSync(body, "fixture text\n");
			const context = spawnSync(
				process.execPath,
				[join(scripts, "context.mjs")],
				{ cwd: directory, encoding: "utf8", timeout: 10000 },
			);
			assert.equal(context.status, 0, context.stderr);
			assert.match(context.stdout, /Repository policy: follow AGENTS\.md/u);
			assert.doesNotMatch(
				context.stdout,
				/BUILD_INIT_REQUIRED|PRODUCT_INIT_REQUIRED|AUTONOMY_DIRECTIVE_CHECK|SUBAGENT_AUTHORIZATION|UPDATE_AVAILABLE/u,
			);
			writeFileSync(
				join(directory, "package.json"),
				'{"name":"visual-test"}\n',
			);
			writeFileSync(join(directory, "index.html"), "<main>Example</main>\n");
			const live = spawnSync(
				process.execPath,
				[join(scripts, "live.mjs"), "--target", "index.html"],
				{ cwd: directory, encoding: "utf8", timeout: 10000 },
			);
			assert.equal(live.status, 0, live.stderr);
			assert.equal(JSON.parse(live.stdout).error, "config_missing");
			const seed = spawnSync(
				process.execPath,
				[
					join(scripts, "concept-seed.mjs"),
					"--scope",
					"surface",
					"--from",
					"12345678",
				],
				{
					cwd: directory,
					encoding: "utf8",
					timeout: 10000,
					env: {
						...process.env,
						DO_NOT_TRACK: "1",
						IMPECCABLE_API_URL: "http://127.0.0.1:1",
						IMPECCABLE_API_TIMEOUT: "150",
						IMPECCABLE_CATALOG_DIR: join(directory, "absent-catalog"),
					},
				},
			);
			assert.equal(seed.status, 0, seed.stderr);
			assert.match(
				seed.stdout,
				/Continue from the existing source and user request/u,
			);
			assert.doesNotMatch(
				seed.stdout,
				/write PRODUCT\.md|DESIGN\.md|serve-question\.mjs/u,
			);
			const hook = await import(
				pathToFileURL(join(scripts, "hook-lib.mjs")).href
			);
			assert.deepEqual(
				hook.designSystemOptions(
					{},
					{
						loadDesignSystemForCwd: () => {
							throw new Error("unexpected design document read");
						},
					},
					directory,
				),
				{},
			);
			assert.equal(
				hook.appendDesignSystemNote("checked", {
					designSystem: { mdNewerThanJson: true },
				}),
				"checked",
			);
			const brief = spawnSync(
				process.execPath,
				[join(scripts, "surface-brief.mjs"), "write", "src/example.tsx", body],
				{ cwd: directory, encoding: "utf8" },
			);
			assert.notEqual(brief.status, 0);
			assert.match(
				brief.stderr,
				/Repository policy forbids surface brief files/u,
			);
			const critique = spawnSync(
				process.execPath,
				[join(scripts, "critique-storage.mjs"), "write", "example", body],
				{ cwd: directory, encoding: "utf8" },
			);
			assert.notEqual(critique.status, 0);
			assert.match(
				critique.stderr,
				/Repository policy forbids critique files/u,
			);
			assert.equal(existsSync(join(directory, ".impeccable")), false);
			mkdirSync(join(directory, ".impeccable", "live"), { recursive: true });
			writeFileSync(
				join(directory, ".impeccable", "live", "config.json"),
				JSON.stringify({
					files: ["index.html"],
					insertBefore: "</body>",
					commentSyntax: "html",
				}),
			);
			writeFileSync(
				join(directory, "index.html"),
				"<html><body><main>Example</main></body></html>\n",
			);
			try {
				const boot = spawnSync(
					process.execPath,
					[join(scripts, "live.mjs"), "--target", "index.html"],
					{ cwd: directory, encoding: "utf8", timeout: 20000 },
				);
				assert.equal(boot.status, 0, boot.stderr);
				const result = JSON.parse(boot.stdout);
				assert.equal(result.ok, true, result.error);
				assert.equal(result.hasProduct, false);
				assert.equal(Object.hasOwn(result, "design"), false);
				assert.equal(Object.hasOwn(result, "surfaceBrief"), false);
				assert.match(
					readFileSync(join(directory, "index.html"), "utf8"),
					/impeccable-live/u,
				);
			} finally {
				spawnSync(
					process.execPath,
					[join(scripts, "live-server.mjs"), "stop"],
					{
						cwd: directory,
						encoding: "utf8",
						timeout: 10000,
					},
				);
				rmSync(join(directory, ".impeccable"), {
					recursive: true,
					force: true,
				});
			}
			const browser = readFileSync(join(scripts, "live-browser.js"), "utf8");
			assert.doesNotMatch(
				browser,
				/Create one by running|to refresh the sidecar|init to generate one/u,
			);
			const legacyDesign = join(directory, "DESIGN.json");
			writeFileSync(legacyDesign, '{"schemaVersion":1}\n');
			writeFileSync(join(directory, "DESIGN.md"), "# Existing design\n");
			const doctor = spawnSync(
				process.execPath,
				[join(scripts, "doctor.mjs"), "--fix", "--json"],
				{ cwd: directory, encoding: "utf8", timeout: 10000 },
			);
			assert.equal(doctor.status, 0, doctor.stderr);
			assert.match(doctor.stdout, /design-artifact-present/u);
			assert.match(doctor.stdout, /design-document-present/u);
			assert.match(doctor.stdout, /Complete any unfinished behavior/u);
			assert.equal(readFileSync(legacyDesign, "utf8"), '{"schemaVersion":1}\n');
			assert.equal(
				existsSync(join(directory, ".impeccable", "design.json")),
				false,
			);
			for (const reference of [
				"new-work",
				"shape",
				"visualize",
				"doctor",
				"critique",
				"craft",
				"routing",
				"degraded/asset-producer",
			]) {
				const text = readFileSync(
					join(skill, "reference", `${reference}.md`),
					"utf8",
				);
				assert.match(text, /AGENTS\.md/u);
				assert.doesNotMatch(
					text,
					/write DESIGN\.md|persist a snapshot|return a confirmed design brief|create missing PRODUCT\.md|decision card packet/iu,
				);
			}
			for (const reference of ["animate", "extract", "optimize", "live"]) {
				const text = readFileSync(
					join(skill, "reference", `${reference}.md`),
					"utf8",
				);
				assert.doesNotMatch(
					text,
					/write a short plan before implementation|create (?:a )?systematic (?:improvement )?plan|read PRODUCT\.md's Brand Personality/iu,
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("visual agent definitions follow the common source policy", () => {
	for (const file of [
		".agents/skills/impeccable/agents/impeccable_asset_producer.toml",
		".agents/skills/impeccable/agents/impeccable_documenter.toml",
		".agents/skills/impeccable/agents/impeccable_finish_reviewer.toml",
		".cursor/agents/impeccable-documenter.md",
		".cursor/agents/impeccable-asset-producer.md",
		".cursor/agents/impeccable-finish-reviewer.md",
		".github/agents/impeccable-documenter.agent.md",
		".github/agents/impeccable-asset-producer.agent.md",
		".github/agents/impeccable-finish-reviewer.agent.md",
	]) {
		const instructions = readFileSync(resolve(file), "utf8");
		assert.match(instructions, /AGENTS\.md/u, file);
		assert.doesNotMatch(
			instructions,
			/write DESIGN\.md|records DESIGN\.md|decision card packet/iu,
			file,
		);
	}
});

test("agent guidance refers to implemented sources rather than retired design documents", () => {
	const files = ["AGENTS.md"];
	for (const harness of [".agents", ".claude"]) {
		files.push(
			`${harness}/skills/hobo-deploy/SKILL.md`,
			`${harness}/skills/optimizexp/references/dx/repo-package-hierarchy.md`,
			`${harness}/skills/optimizexp/references/ax/specs.md`,
			`${harness}/skills/optimizexp/references/ax/auth.md`,
		);
	}
	for (const file of files) {
		assert.doesNotMatch(
			readFileSync(resolve(file), "utf8"),
			/docs\/design\//u,
			file,
		);
	}
});
