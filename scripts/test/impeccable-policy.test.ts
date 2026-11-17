import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

for (const harness of [".agents", ".claude", ".cursor", ".github"]) {
	test(`${harness} visual skill uses source context and refuses planning files`, () => {
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
			]) {
				const text = readFileSync(
					join(skill, "reference", `${reference}.md`),
					"utf8",
				);
				assert.match(text, /AGENTS\.md/u);
				assert.doesNotMatch(
					text,
					/write DESIGN\.md|persist a snapshot|return a confirmed design brief/iu,
				);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("visual agent definitions follow the common source policy", () => {
	for (const file of [
		".agents/skills/impeccable/agents/impeccable_documenter.toml",
		".agents/skills/impeccable/agents/impeccable_finish_reviewer.toml",
		".cursor/agents/impeccable-documenter.md",
		".cursor/agents/impeccable-finish-reviewer.md",
		".github/agents/impeccable-documenter.agent.md",
		".github/agents/impeccable-finish-reviewer.agent.md",
	]) {
		const instructions = readFileSync(resolve(file), "utf8");
		assert.match(instructions, /AGENTS\.md/u, file);
		assert.doesNotMatch(
			instructions,
			/write DESIGN\.md|records DESIGN\.md/iu,
			file,
		);
	}
});
