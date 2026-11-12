/**
 * Every `--project` / `--projects` example in the skill names a project this
 * repo actually has, and the harness falls back to no hard-coded project id.
 * A documented command that names a removed project fails at its first step,
 * and a fallback that names one silently picks nothing.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { listProjects } from "../lib/projects.mts";
import { repoRoot } from "../lib/paths.mts";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLACEHOLDERS = new Set(["all", "a", "b", "c"]);

function skillTexts(): { file: string; text: string }[] {
	const files = [
		"SKILL.md",
		...readdirSync(path.join(skillDir, "references"))
			.filter((name) => name.endsWith(".md"))
			.map((name) => path.join("references", name)),
		...readdirSync(path.join(skillDir, "harness"))
			.filter((name) => name.endsWith(".mts"))
			.map((name) => path.join("harness", name)),
		...readdirSync(path.join(skillDir, "harness", "lib"))
			.filter((name) => name.endsWith(".mts"))
			.map((name) => path.join("harness", "lib", name)),
	];
	return files.map((file) => ({
		file,
		text: readFileSync(path.join(skillDir, file), "utf8"),
	}));
}

describe("optimizexp project examples", () => {
	it("names only projects the repo has", () => {
		const known = new Set(listProjects(repoRoot(skillDir)).map((p) => p.id));
		const unknown: string[] = [];
		for (const { file, text } of skillTexts()) {
			// Only command examples: lines that invoke a harness script.
			for (const line of text.split("\n").filter((l) => /harness\/[a-z-]+\.mts/.test(l))) {
				for (const match of line.matchAll(/--projects?[ =]([a-z0-9][a-z0-9,-]*)/g)) {
					for (const id of (match[1] ?? "").split(",")) {
						if (!PLACEHOLDERS.has(id) && !known.has(id)) unknown.push(`${file}: ${id}`);
					}
				}
			}
		}
		assert.deepEqual(unknown, []);
	});

	it("hard-codes no project id as a fallback", () => {
		const fallbacks = skillTexts()
			.filter(({ text }) => /\bp\.id === "code"/.test(text))
			.map(({ file }) => file);
		assert.deepEqual(fallbacks, []);
	});
});
