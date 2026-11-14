import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// The mirrored .agents/skills tree as a distributable module. Skills are static markdown content; this module parses them into the
// typed manifest a Registry listing serves. Parse, don't validate: the
// frontmatter lowers onto parsed derived types or throws — no boolean checks
// over raw strings escape this boundary.

// public-contract: manifest schema id Registry listings pin.
export const AGENT_SKILLS_MANIFEST_SCHEMA = "hobo.agent-skills-manifest/v1";

// domain-view: parse-produced manifest entry; wire form is SkillManifestEntry in data-models/agent_skills.proto.
export interface SkillManifestEntry {
	readonly name: string;
	readonly description: string;
	/** Bundle-relative path to the skill's SKILL.md. */
	readonly entry: string;
}

// domain-view: parse-produced manifest; wire form is SkillsManifest in data-models/agent_skills.proto.
export interface SkillsManifest {
	readonly schema: typeof AGENT_SKILLS_MANIFEST_SCHEMA;
	readonly skills: readonly SkillManifestEntry[];
}

export type SkillConformanceIssue = {
	readonly skill: string;
	readonly code: "unparseable" | "duplicate-name" | "missing-skill-md";
	readonly message: string;
};

/** Typed parse failure raised at the skill authoring boundary. */
export class SkillParseError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "SkillParseError";
	}
}

/**
 * Parse a SKILL.md's YAML frontmatter into a manifest entry (minus the
 * entry path, which the tree scan supplies). Only the `name:` and
 * `description:` scalar lines are read — the deliberately tiny YAML subset
 * every skill in the tree actually uses; anything else in the block is
 * ignored. Missing block, missing name, or missing description throws.
 */
export function parseSkillFrontmatter(
	markdown: string,
): Omit<SkillManifestEntry, "entry"> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown);
	if (!match || match[1] === undefined) {
		throw new SkillParseError("SKILL.md has no frontmatter block");
	}
	const fields = new Map<string, string>();
	for (const line of match[1].split(/\r?\n/u)) {
		const field = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
		if (field && field[1] !== undefined && field[2] !== undefined) {
			fields.set(field[1], field[2].trim());
		}
	}
	const name = fields.get("name");
	if (name === undefined || name.length === 0) {
		throw new SkillParseError("frontmatter is missing a non-empty name");
	}
	const description = fields.get("description");
	if (description === undefined || description.length === 0) {
		throw new SkillParseError(
			`skill "${name}" frontmatter is missing a non-empty description`,
		);
	}
	return Object.freeze({ name, description });
}

/**
 * Scan a skills tree (one directory per skill, each holding a SKILL.md)
 * into the typed manifest, deterministically sorted by skill name.
 */
export async function loadSkillsManifest(
	root: string,
): Promise<SkillsManifest> {
	const skills: SkillManifestEntry[] = [];
	for (const dirent of await readdir(root, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const entry = join(dirent.name, "SKILL.md");
		const markdown = await readFile(join(root, entry), "utf8");
		const parsed = parseSkillFrontmatter(markdown);
		skills.push(Object.freeze({ ...parsed, entry }));
	}
	skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return Object.freeze({
		schema: AGENT_SKILLS_MANIFEST_SCHEMA,
		skills: Object.freeze(skills),
	});
}

/**
 * The bundle conformance gate: every skill directory has a SKILL.md that
 * parses, and no two skills share a name. Returns every issue found rather
 * than failing fast, so a bundle author sees the whole repair list.
 */
export async function checkSkillsConformance(
	root: string,
): Promise<readonly SkillConformanceIssue[]> {
	const issues: SkillConformanceIssue[] = [];
	const seen = new Map<string, string>();
	for (const dirent of await readdir(root, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const skillMd = join(root, dirent.name, "SKILL.md");
		try {
			await stat(skillMd);
		} catch {
			issues.push({
				skill: dirent.name,
				code: "missing-skill-md",
				message: `${dirent.name} has no SKILL.md`,
			});
			continue;
		}
		try {
			const parsed = parseSkillFrontmatter(await readFile(skillMd, "utf8"));
			const prior = seen.get(parsed.name);
			if (prior !== undefined) {
				issues.push({
					skill: dirent.name,
					code: "duplicate-name",
					message: `skill name "${parsed.name}" is also declared by ${prior}`,
				});
			} else {
				seen.set(parsed.name, dirent.name);
			}
		} catch (error) {
			// SAFETY: caught values may be non-Error, so message access is guarded by the fallback.
			issues.push({
				skill: dirent.name,
				code: "unparseable",
				message: String((error as Error).message ?? error),
			});
		}
	}
	return Object.freeze(issues);
}
