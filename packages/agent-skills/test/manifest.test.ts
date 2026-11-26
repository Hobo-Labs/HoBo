import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	AGENT_SKILLS_MANIFEST_SCHEMA,
	checkSkillsConformance,
	loadSkillsManifest,
	parseSkillFrontmatter,
	SkillParseError,
} from "../src/index.js";

// The real mirrored tree this package distributes.
const REPO_SKILLS_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../.agents/skills",
);

const scratches: string[] = [];
afterEach(async () => {
	while (scratches.length > 0) {
		const dir = scratches.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function scratchTree(
	skills: Record<string, string | null>,
): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-skills-"));
	scratches.push(root);
	for (const [name, skillMd] of Object.entries(skills)) {
		await mkdir(path.join(root, name), { recursive: true });
		if (skillMd !== null) {
			await writeFile(path.join(root, name, "SKILL.md"), skillMd);
		}
	}
	return root;
}

describe("parseSkillFrontmatter", () => {
	it("parses name + description and ignores extra fields", () => {
		const parsed = parseSkillFrontmatter(
			"---\nname: sdlc\ndescription: run the loop\nallowed-tools: Bash\n---\n# body\n",
		);
		expect(parsed).toEqual({ name: "sdlc", description: "run the loop" });
	});

	it("throws typed errors on missing block, name, or description", () => {
		expect(() => parseSkillFrontmatter("# no frontmatter")).toThrow(
			SkillParseError,
		);
		expect(() => parseSkillFrontmatter("---\ndescription: d\n---\n")).toThrow(
			/name/u,
		);
		expect(() => parseSkillFrontmatter("---\nname: x\n---\n")).toThrow(
			/description/u,
		);
	});
});

describe("loadSkillsManifest", () => {
	it("scans a tree into a deterministically sorted manifest", async () => {
		const root = await scratchTree({
			zeta: "---\nname: zeta\ndescription: z\n---\n",
			alpha: "---\nname: alpha\ndescription: a\n---\n",
		});
		const manifest = await loadSkillsManifest(root);
		expect(manifest.schema).toBe(AGENT_SKILLS_MANIFEST_SCHEMA);
		expect(manifest.skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
		expect(manifest.skills[0]?.entry).toBe(path.join("alpha", "SKILL.md"));
	});

	it("parses the repo's real mirrored .agents/skills tree", async () => {
		const manifest = await loadSkillsManifest(REPO_SKILLS_ROOT);
		expect(manifest.skills.length).toBeGreaterThan(20);
		expect(manifest.skills.map((s) => s.name)).toContain("sdlc");
	});
});

describe("checkSkillsConformance", () => {
	it("passes the repo's real tree with zero issues", async () => {
		expect(await checkSkillsConformance(REPO_SKILLS_ROOT)).toEqual([]);
	});

	it("reports missing SKILL.md, duplicates, and unparseable frontmatter", async () => {
		const root = await scratchTree({
			ok: "---\nname: ok\ndescription: fine\n---\n",
			dupe: "---\nname: ok\ndescription: clash\n---\n",
			broken: "no frontmatter here",
			empty: null,
		});
		const issues = await checkSkillsConformance(root);
		const codes = issues.map((issue) => issue.code).sort();
		expect(codes).toEqual([
			"duplicate-name",
			"missing-skill-md",
			"unparseable",
		]);
	});
});
