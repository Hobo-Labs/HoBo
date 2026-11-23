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

const script = resolve(
	".agents/skills/skill-creator-plus/scripts/init_skill.py",
);
const validator = resolve(
	".agents/skills/skill-creator-plus/scripts/quick_validate.py",
);

function run(args: string[]) {
	return spawnSync("python3", [script, ...args], {
		encoding: "utf8",
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
	});
}

test("creates a complete skill from supplied instructions without placeholder resources", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-skill-create-"));
	try {
		const instructions = join(directory, "instructions.txt");
		writeFileSync(
			instructions,
			"## Todo application\n\nInspect the input, run the checker, and report failures.\n",
		);
		const result = run([
			"validate-data",
			"--path",
			directory,
			"--description",
			"Validate a todo application: inspect its data.",
			"--instructions-file",
			instructions,
		]);
		assert.equal(result.status, 0, result.stderr);
		const skill = join(directory, "validate-data");
		const content = readFileSync(join(skill, "SKILL.md"), "utf8");
		assert.match(content, /name: validate-data/u);
		assert.match(content, /Inspect the input, run the checker/u);
		assert.match(content, /Follow the repository rules in `AGENTS\.md`/u);
		for (const name of ["scripts", "references", "assets"])
			assert.equal(existsSync(join(skill, name)), false);
		const validation = spawnSync("python3", [validator, skill], {
			encoding: "utf8",
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		});
		assert.equal(validation.status, 0, validation.stderr);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects missing, unfinished, invalid, and conflicting inputs without changing files", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-skill-invalid-"));
	try {
		const instructions = join(directory, "instructions.txt");
		writeFileSync(instructions, "[TODO: finish this workflow]\n");
		const pending = run([
			"unfinished",
			"--path",
			directory,
			"--description",
			"A real description",
			"--instructions-file",
			instructions,
		]);
		assert.notEqual(pending.status, 0);
		assert.equal(existsSync(join(directory, "unfinished")), false);
		writeFileSync(instructions, "Run the complete workflow.\n");
		const invalid = run([
			"../escape",
			"--path",
			directory,
			"--description",
			"A real description",
			"--instructions-file",
			instructions,
		]);
		assert.notEqual(invalid.status, 0);
		const missing = run(["missing", "--path", directory]);
		assert.notEqual(missing.status, 0);
		assert.equal(existsSync(join(directory, "missing")), false);
		const args = [
			"existing",
			"--path",
			directory,
			"--description",
			"A real description",
			"--instructions-file",
			instructions,
		];
		assert.equal(run(args).status, 0);
		const target = join(directory, "existing", "SKILL.md");
		const original = readFileSync(target, "utf8");
		assert.notEqual(run(args).status, 0);
		assert.equal(readFileSync(target, "utf8"), original);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the validator rejects incomplete and mismatched skills", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-skill-validate-"));
	try {
		const instructions = join(directory, "instructions.txt");
		writeFileSync(instructions, "Run the complete workflow.\n");
		const args = [
			"validated",
			"--path",
			directory,
			"--description",
			"Validate the workflow",
			"--instructions-file",
			instructions,
		];
		assert.equal(run(args).status, 0);
		const skill = join(directory, "validated");
		const target = join(skill, "SKILL.md");
		for (const content of [
			'---\nname: ""\ndescription: "valid"\n---\n\nInstructions\n',
			'---\nname: other\ndescription: "valid"\n---\n\nInstructions\n',
			'---\nname: validated\ndescription: ""\n---\n\nInstructions\n',
			'---\nname: validated\ndescription: "valid"\n---\n',
			'---\nname: validated\ndescription: "valid"\n---\n\n[TODO: implement]\n',
		]) {
			writeFileSync(target, content);
			const result = spawnSync("python3", [validator, skill], {
				encoding: "utf8",
				env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
			});
			assert.notEqual(result.status, 0, content);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
