import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	AGENT_SKILLS_MANIFEST_SCHEMA,
	checkSkillsConformance,
	HOBO_OWNED_SKILLS,
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

	it("decodes quoted name and description scalars", () => {
		const parsed = parseSkillFrontmatter(
			"---\nname: 'sdlc'\ndescription: \"run the loop\"\n---\n# body\n",
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

	it("rejects malformed double-quoted scalars", () => {
		for (const description of ['"bad\\q"', '"unterminated']) {
			expect(() =>
				parseSkillFrontmatter(
					`---\nname: sdlc\ndescription: ${description}\n---\n`,
				),
			).toThrow(SkillParseError);
		}
	});

	it("reads prose that merely ends with a quote character as a plain string", () => {
		for (const description of ['run the "loop"', "owners'"]) {
			expect(
				parseSkillFrontmatter(
					`---\nname: sdlc\ndescription: ${description}\n---\n`,
				),
			).toEqual({ name: "sdlc", description });
		}
	});

	it("rejects unterminated single-quoted top-level scalars", () => {
		expect(() =>
			parseSkillFrontmatter(
				"---\nname: sdlc\ndescription: 'unterminated\n---\n",
			),
		).toThrowError(new SkillParseError("invalid single-quoted YAML scalar"));
	});

	it("rejects unterminated single-quoted metadata scalars", () => {
		expect(() =>
			parseSkillFrontmatter(
				"---\nname: sdlc\ndescription: d\nmetadata:\n  plugin: 'hobo\n---\n",
			),
		).toThrowError(new SkillParseError("invalid single-quoted YAML scalar"));
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
	it("passes the repo's real tree with zero issues, strict set included", async () => {
		expect(await checkSkillsConformance(REPO_SKILLS_ROOT)).toEqual([]);
	});

	it("reports missing SKILL.md, duplicates, and unparseable frontmatter", async () => {
		const root = await scratchTree({
			ok: "---\nname: ok\ndescription: fine\n---\n",
			dupe: "---\nname: ok\ndescription: clash\n---\n",
			broken: "no frontmatter here",
			empty: null,
		});
		const issues = await checkSkillsConformance(root, {
			strictSkillNames: [],
		});
		const codes = issues.map((issue) => issue.code).sort();
		expect(codes).toEqual([
			"duplicate-name",
			"missing-skill-md",
			"unparseable",
		]);
	});

	it("enforces the HoBo-owned frontmatter rules on strict skills only", async () => {
		const root = await scratchTree({
			"hobo-setup":
				"---\nname: hobo-setup\ndescription: d\nlicense: MIT\nmetadata:\n  plugin: hobo\n---\n",
			outsider:
				"---\nname: outsider\ndescription: d\nupstream-field: kept\n---\n",
		});
		expect(await checkSkillsConformance(root)).toEqual([]);
	});

	it("rejects unrecognized non-comment top-level YAML in strict skills", async () => {
		const secrets = [
			"github_pat_abcdefghijklmnopqrst",
			"sk-proj-abcdefghijklmnopqrst",
		];
		const root = await scratchTree({
			"hobo-setup": `---\nname: hobo-setup\ndescription: d\n"legacy": ${secrets[0]}\n---\n`,
			"hobo-deploy": `---\nname: hobo-deploy\ndescription: d\nmetadata:\n  plugin: hobo\nlegacy : ${secrets[1]}\n---\n`,
			outsider: '---\nname: outsider\ndescription: d\n"legacy": x\n---\n',
		});
		const issues = await checkSkillsConformance(root);
		expect(issues).toHaveLength(2);
		expect(issues.map((issue) => issue.skill).sort()).toEqual([
			"hobo-deploy",
			"hobo-setup",
		]);
		expect(issues.every((issue) => issue.code === "unparseable")).toBe(true);
		expect(
			issues.every(
				(issue) => issue.message === "unrecognized top-level YAML line",
			),
		).toBe(true);
		for (const secret of secrets) {
			expect(issues.map((issue) => issue.message).join("\n")).not.toContain(
				secret,
			);
		}
	});

	it("never echoes credential-shaped rejected values in issue messages", async () => {
		const secrets = [
			"sk-abcdefghijklmnopqrst",
			"github_pat_abcdefghijklmnopqrst",
		];
		const root = await scratchTree({
			"hobo-setup": `---\nname: ${secrets[0]}\ndescription: d\n---\n`,
			"hobo-deploy": `---\nname: hobo-deploy\ndescription: d\n${secrets[0]}: x\n---\n`,
			draft: `---\nname: draft\ndescription: d\nlicense:\n  ${secrets[0]}: x\n---\n`,
			repo: `---\nname: ${secrets[1]}\ndescription: d\n---\n`,
			sdlc: `---\nname: ${secrets[1]}\ndescription: d\n---\n`,
			outsider: `---\nname: ${secrets[0]}\n---\n`,
		});
		const issues = await checkSkillsConformance(root);
		const codes = new Set(issues.map((issue) => issue.code));
		for (const code of [
			"name-folder-mismatch",
			"disallowed-frontmatter-field",
			"nested-frontmatter-field",
			"duplicate-name",
			"unparseable",
		]) {
			expect(codes.has(code)).toBe(true);
		}
		const messages = issues.map((issue) => issue.message).join("\n");
		for (const secret of secrets) {
			expect(messages).not.toContain(secret);
		}
	});

	it("reports every strict violation a HoBo-owned skill can make", async () => {
		const root = await scratchTree({
			"hobo-setup": "---\nname: hobo-setup\ndescription: d\nlegacy: x\n---\n",
			"hobo-deploy":
				"---\nname: hobo-deploy\ndescription: d\nmetadata:\n  nested:\n    deep: value\n---\n",
			draft: "---\nname: not-draft\ndescription: d\n---\n",
			repo: "---\nname: repo\ndescription: d\nmetadata: scalar\n---\n",
		});
		const issues = await checkSkillsConformance(root);
		const bySkill = new Map(issues.map((issue) => [issue.skill, issue.code]));
		expect(bySkill.get("hobo-setup")).toBe("disallowed-frontmatter-field");
		expect(bySkill.get("hobo-deploy")).toBe("non-string-metadata");
		expect(bySkill.get("draft")).toBe("name-folder-mismatch");
		expect(bySkill.get("repo")).toBe("non-string-metadata");
	});

	it("validates decoded metadata scalar types and quoted strings", async () => {
		const root = await scratchTree({
			"hobo-setup":
				"---\nname: hobo-setup\ndescription: d\nmetadata:\n  version: 1\n  enabled: true\n---\n",
			"hobo-deploy":
				'---\nname: hobo-deploy\ndescription: d\nmetadata:\n  empty: ""\n---\n',
			draft:
				"---\nname: draft\ndescription: d\nmetadata:\n  version: \"1\"\n  enabled: 'true'\n---\n",
		});
		const issues = await checkSkillsConformance(root);
		const invalid = issues.filter((issue) => issue.skill !== "draft");
		expect(invalid).toHaveLength(3);
		expect(invalid.every((issue) => issue.code === "non-string-metadata")).toBe(
			true,
		);
		expect(issues.some((issue) => issue.skill === "draft")).toBe(false);
	});

	it("rejects block and flow collections in metadata", async () => {
		const root = await scratchTree({
			"hobo-setup":
				"---\nname: hobo-setup\ndescription: d\nmetadata:\n  - value\n---\n",
			"hobo-deploy":
				"---\nname: hobo-deploy\ndescription: d\nmetadata:\n  key: [value]\n---\n",
		});
		const issues = await checkSkillsConformance(root);
		expect(issues).toHaveLength(2);
		expect(issues.every((issue) => issue.code === "non-string-metadata")).toBe(
			true,
		);
	});

	it("keeps third-party skills outside the default strict set", () => {
		for (const thirdParty of ["impeccable", "unity-cli", "caveman"]) {
			expect(HOBO_OWNED_SKILLS.includes(thirdParty)).toBe(false);
		}
		expect(HOBO_OWNED_SKILLS).toContain("hobo-setup");
		expect(HOBO_OWNED_SKILLS).toContain("hobo-deploy");
		expect(HOBO_OWNED_SKILLS).toContain("design-md");
	});
});
