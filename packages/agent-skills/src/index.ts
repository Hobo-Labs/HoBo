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
	readonly code:
		| "unparseable"
		| "duplicate-name"
		| "missing-skill-md"
		| "disallowed-frontmatter-field"
		| "nested-frontmatter-field"
		| "name-folder-mismatch"
		| "non-string-metadata";
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
	const frontmatter = parseFrontmatterFields(markdown);
	const name = frontmatter.fields.get("name");
	if (name?.kind !== "string" || name.value.length === 0) {
		throw new SkillParseError("frontmatter is missing a non-empty name");
	}
	const description = frontmatter.fields.get("description");
	if (description?.kind !== "string" || description.value.length === 0) {
		throw new SkillParseError(
			`skill "${name.value}" frontmatter is missing a non-empty description`,
		);
	}
	return Object.freeze({ name: name.value, description: description.value });
}

export const HOBO_OWNED_ALLOWED_FIELDS: readonly string[] = [
	"name",
	"description",
	"license",
	"compatibility",
	"metadata",
	"allowed-tools",
];

export const HOBO_OWNED_SKILLS: readonly string[] = [
	"design-md",
	"draft",
	"hobo-deploy",
	"hobo-setup",
	"optimizexp",
	"repo",
	"sdlc",
] as const;

type YamlScalar =
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "null"; readonly value: null };

type FrontmatterFields = {
	readonly fields: ReadonlyMap<string, YamlScalar>;
	readonly children: ReadonlyMap<string, ReadonlyMap<string, YamlScalar>>;
	readonly deeplyNested: ReadonlySet<string>;
};

function parseYamlScalar(value: string): YamlScalar {
	const scalar = value.trim();
	if (scalar.length >= 2 && scalar.startsWith('"') && scalar.endsWith('"')) {
		try {
			return { kind: "string", value: String(JSON.parse(scalar)) };
		} catch {
			return { kind: "string", value: scalar.slice(1, -1) };
		}
	}
	if (scalar.length >= 2 && scalar.startsWith("'") && scalar.endsWith("'")) {
		return {
			kind: "string",
			value: scalar.slice(1, -1).replaceAll("''", "'"),
		};
	}
	if (/^(?:true|false)$/iu.test(scalar)) {
		return { kind: "boolean", value: scalar.toLowerCase() === "true" };
	}
	if (scalar === "" || scalar === "~" || /^null$/iu.test(scalar)) {
		return { kind: "null", value: null };
	}
	if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/iu.test(scalar)) {
		return { kind: "number", value: Number(scalar) };
	}
	return { kind: "string", value: scalar };
}

function parseFrontmatterFields(markdown: string): FrontmatterFields {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown);
	if (!match || match[1] === undefined) {
		throw new SkillParseError("SKILL.md has no frontmatter block");
	}
	const fields = new Map<string, YamlScalar>();
	const children = new Map<string, Map<string, YamlScalar>>();
	const deeplyNested = new Set<string>();
	let currentNestedField: string | undefined;
	for (const line of match[1].split(/\r?\n/u)) {
		const top = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
		if (top && top[1] !== undefined && top[2] !== undefined) {
			fields.set(top[1], parseYamlScalar(top[2]));
			currentNestedField =
				top[2].trim() === "" && top[1] !== "name" && top[1] !== "description"
					? top[1]
					: undefined;
			if (currentNestedField !== undefined)
				children.set(currentNestedField, new Map());
			continue;
		}
		if (currentNestedField === undefined) continue;
		const child = /^ {2,}([^:\s]+):\s*(.*)$/u.exec(line);
		if (child && child[1] !== undefined && child[2] !== undefined) {
			if (/^ {4,}\S/u.test(line) || child[2].trim().startsWith("{")) {
				deeplyNested.add(currentNestedField);
				continue;
			}
			children
				.get(currentNestedField)
				?.set(child[1], parseYamlScalar(child[2]));
		}
	}
	return { fields, children, deeplyNested };
}

function strictSkillIssues(
	skill: string,
	markdown: string,
): SkillConformanceIssue[] {
	const issues: SkillConformanceIssue[] = [];
	let frontmatter: FrontmatterFields;
	try {
		frontmatter = parseFrontmatterFields(markdown);
	} catch (error) {
		return [
			{
				skill,
				code: "unparseable",
				message: error instanceof Error ? error.message : String(error),
			},
		];
	}
	for (const field of frontmatter.fields.keys()) {
		if (!HOBO_OWNED_ALLOWED_FIELDS.includes(field)) {
			issues.push({
				skill,
				code: "disallowed-frontmatter-field",
				message: `field "${field}" is not one of ${HOBO_OWNED_ALLOWED_FIELDS.join(", ")}`,
			});
		}
	}
	const name = frontmatter.fields.get("name");
	if (name !== undefined && (name.kind !== "string" || name.value !== skill)) {
		issues.push({
			skill,
			code: "name-folder-mismatch",
			message: `frontmatter name "${name.value}" does not match folder "${skill}"`,
		});
	}
	const metadata = frontmatter.children.get("metadata");
	if (frontmatter.fields.has("metadata") && metadata === undefined) {
		issues.push({
			skill,
			code: "non-string-metadata",
			message: "metadata must be a map of string values, not a scalar",
		});
	}
	for (const [field, children] of frontmatter.children) {
		if (field !== "metadata") {
			issues.push({
				skill,
				code: "nested-frontmatter-field",
				message: `field "${field}" must be a scalar; nested blocks are only allowed under metadata`,
			});
			continue;
		}
		if (frontmatter.deeplyNested.has(field)) {
			issues.push({
				skill,
				code: "non-string-metadata",
				message: "metadata values must be strings, not nested structures",
			});
		}
		for (const value of children.values()) {
			if (value.kind !== "string" || value.value.length === 0) {
				issues.push({
					skill,
					code: "non-string-metadata",
					message: "metadata values must be non-empty strings",
				});
			}
		}
	}
	return issues;
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

export type SkillsConformanceOptions = {
	readonly strictSkillNames?: readonly string[];
};

/**
 * The bundle conformance gate: every skill directory has a SKILL.md that
 * parses, and no two skills share a name. Returns every issue found rather
 * than failing fast, so a bundle author sees the whole repair list.
 */
export async function checkSkillsConformance(
	root: string,
	options: SkillsConformanceOptions = {},
): Promise<readonly SkillConformanceIssue[]> {
	const strictSkills = new Set(options.strictSkillNames ?? HOBO_OWNED_SKILLS);
	const issues: SkillConformanceIssue[] = [];
	const seen = new Map<string, string>();
	for (const dirent of await readdir(root, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const skillMd = join(root, dirent.name, "SKILL.md");
		let markdown: string;
		try {
			await stat(skillMd);
			markdown = await readFile(skillMd, "utf8");
		} catch {
			issues.push({
				skill: dirent.name,
				code: "missing-skill-md",
				message: `${dirent.name} has no SKILL.md`,
			});
			continue;
		}
		if (strictSkills.has(dirent.name)) {
			issues.push(...strictSkillIssues(dirent.name, markdown));
		}
		try {
			const parsed = parseSkillFrontmatter(markdown);
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
