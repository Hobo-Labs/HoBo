/**
 * Validate-mode tests for generate-persona.mts Source seed capture.
 * Regression: the seed-section regex once used `[\\s\\S]` inside a regex
 * literal, which matches literal "\s" text and always captured empty, forcing
 * generatedFromSeed:true personas to fail validation.
 * Run: node --import tsx --test .agents/skills/optimizexp/harness/test/generate-persona-validate.test.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// harness/test → harness → optimizexp → skills → .agents → repo root
const REPO = path.resolve(
	path.dirname(new URL(import.meta.url).pathname),
	"../../../../..",
);
const GP = path.join(
	REPO,
	".agents/skills/optimizexp/harness/generate-persona.mts",
);
// Real schema-v2 seed-generated persona used as the valid template.
const TEMPLATE = readFileSync(
	path.join(REPO, ".optimizexp/personas/role-sre.md"),
	"utf8",
);

function seedDigest(seed: string): string {
	return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function seedSectionText(persona: string): string {
	const body = persona.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
	const seedBody = body.match(/^## Source seed[ \t]*\r?\n([\s\S]*)$/m)?.[1] ?? "";
	return seedBody.split(/^## /m)[0]?.trim() ?? "";
}

function validatePersona(persona: string): {
	ok: boolean;
	problems: string[];
} {
	const root = mkdtempSync(path.join(tmpdir(), "oxp-gp-validate-"));
	// repoRoot() walks up for .git; without it the tmp root is not discovered.
	mkdirSync(path.join(root, ".git"));
	const dir = path.join(root, ".optimizexp", "personas");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "role-sre.md"), persona);
	const r = spawnSync(
		path.join(REPO, "node_modules", ".bin", "tsx"),
		[GP, "--mode", "validate"],
		{ cwd: root, encoding: "utf8", env: process.env },
	);
	if (r.status !== 0 && !r.stdout) {
		assert.fail(`validate crashed: ${r.stderr}`);
	}
	const json = JSON.parse(r.stdout);
	assert.equal(json.personas.length, 1, "tmp-root persona must be discovered");
	return {
		ok: json.ok,
		problems: json.personas.flatMap(
			(p: { problems: string[] }) => p.problems,
		),
	};
}

describe("generate-persona validate: Source seed capture", () => {
	it("captures a non-empty seed and passes with matching digest", () => {
		const seed = seedSectionText(TEMPLATE);
		assert.ok(seed.length > 0, "template must have a Source seed section");
		const persona = TEMPLATE.replace(
			/^seedDigest: .*$/m,
			`seedDigest: "${seedDigest(seed)}"`,
		);
		const { ok, problems } = validatePersona(persona);
		assert.deepEqual(problems, []);
		assert.equal(ok, true);
	});

	it("fails when generatedFromSeed:true has an empty Source seed section", () => {
		const persona = TEMPLATE.replace(
			/^(## Source seed[ \t]*\r?\n)[\s\S]*$/m,
			"$1\n",
		);
		const { ok, problems } = validatePersona(persona);
		assert.equal(ok, false);
		assert.ok(
			problems.some((p) => p.includes("non-empty source seed")),
			`expected non-empty source seed problem, got: ${problems.join("; ")}`,
		);
	});

	it("fails when seedDigest does not match the Source seed text", () => {
		const persona = TEMPLATE.replace(
			/^seedDigest: .*$/m,
			'seedDigest: "0000000000000000"',
		);
		const { ok, problems } = validatePersona(persona);
		assert.equal(ok, false);
		assert.ok(
			problems.some((p) => p.includes("seedDigest does not match")),
			`expected digest mismatch problem, got: ${problems.join("; ")}`,
		);
	});

	it("passes for non-seed personas (generatedFromSeed:false, seedDigest:null)", () => {
		const persona = TEMPLATE.replace(
			/^generatedFromSeed: true$/m,
			"generatedFromSeed: false",
		).replace(/^seedDigest: .*$/m, "seedDigest: null");
		const { ok, problems } = validatePersona(persona);
		assert.deepEqual(problems, []);
		assert.equal(ok, true);
	});
});
