import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// The mirrored .agents/skills tree as a distributable module. Skills are static markdown content; this module parses them into the
// typed manifest a Registry listing serves. Parse, don't validate: the
// frontmatter lowers onto parsed derived types or throws — no boolean checks
// over raw strings escape this boundary.

// public-contract: manifest schema id Registry listings pin.
export const AGENT_SKILLS_MANIFEST_SCHEMA = "hobo.agent-skills-manifest/v1";

function isMissingFileError(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}

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
		| "non-string-metadata"
		| "lock-exempts-repo-skill"
		| "lock-shadows-in-tree-skill";
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
		throw new SkillParseError("frontmatter is missing a non-empty description");
	}
	return Object.freeze({ name: name.value, description: description.value });
}

export const HOBO_OWNED_ALLOWED_FIELDS: readonly string[] = Object.freeze([
	"name",
	"description",
	"license",
	"compatibility",
	"metadata",
	"allowed-tools",
]);

export function skillUsesHoboOwnedFrontmatter(
	frontmatter: FrontmatterFields,
): boolean {
	for (const key of frontmatter.fields.keys()) {
		if (!HOBO_OWNED_ALLOWED_FIELDS.includes(key)) {
			return false;
		}
	}
	return true;
}

const HOBO_REVIEWED_VENDORED_SKILL_NAMES: ReadonlySet<string> = new Set([
	"ask-matt",
	"cavecrew",
	"caveman",
	"caveman-commit",
	"caveman-compress",
	"caveman-help",
	"caveman-review",
	"caveman-stats",
	"codebase-design",
	"decision-mapping",
	"design-an-interface",
	"diagnosing-bugs",
	"domain-modeling",
	"edit-article",
	"git-guardrails-claude-code",
	"grill-me",
	"grill-with-docs",
	"grilling",
	"handoff",
	"implement",
	"impeccable",
	"improve-codebase-architecture",
	"install-anti-slop",
	"loop-me",
	"migrate-to-shoehorn",
	"obsidian-vault",
	"ponytail",
	"ponytail-audit",
	"ponytail-debt",
	"ponytail-gain",
	"ponytail-help",
	"ponytail-review",
	"prototype",
	"qa",
	"request-refactor-plan",
	"resolving-merge-conflicts",
	"review",
	"scaffold-exercises",
	"setup-matt-pocock-skills",
	"setup-pre-commit",
	"spriterrific-api",
	"tdd",
	"teach",
	"to-issues",
	"to-prd",
	"triage",
	"ubiquitous-language",
	"wizard",
	"writing-beats",
	"writing-fragments",
	"writing-great-skills",
	"writing-shape",
]);

function vendoredNamesFromLockJson(text: string): ReadonlySet<string> {
	/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: skills-lock.json is untrusted JSON; only skill name keys are read after a shallow object check. */
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new SkillParseError(
			`skills-lock.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (typeof parsed !== "object" || parsed === null) {
		return new Set();
	}
	const skills = "skills" in parsed ? parsed.skills : undefined;
	if (typeof skills !== "object" || skills === null) {
		return new Set();
	}
	return new Set(Object.keys(skills));
	/* oxlint-enable anti-slop/no-runtime-typeof */
}

async function loadVendoredSkillNames(
	repoRoot: string,
): Promise<ReadonlySet<string>> {
	let text: string;
	try {
		text = await readFile(join(repoRoot, "skills-lock.json"), "utf8");
	} catch (error) {
		throw new SkillParseError(
			`skills-lock.json is required for HoBo-owned skill discovery (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	return vendoredNamesFromLockJson(text);
}

export async function discoverHoboOwnedSkillNames(
	skillsRoot: string,
	repoRoot: string,
): Promise<readonly string[]> {
	const vendored = await loadVendoredSkillNames(repoRoot);
	const names: string[] = [];
	for (const dirent of await readdir(skillsRoot, { withFileTypes: true })) {
		if (dirent.isSymbolicLink()) {
			throw new SkillParseError(
				`${dirent.name} must be a real skill directory, not a symbolic link`,
			);
		}
		if (!dirent.isDirectory()) continue;
		if (
			vendored.has(dirent.name) &&
			HOBO_REVIEWED_VENDORED_SKILL_NAMES.has(dirent.name)
		)
			continue;
		const skillMd = join(skillsRoot, dirent.name, "SKILL.md");
		try {
			await stat(skillMd);
			names.push(dirent.name);
		} catch (error) {
			if (!(error instanceof Error && isMissingFileError(error))) throw error;
		}
	}
	names.sort();
	return Object.freeze(names);
}

export const HOBO_PORTABLE_PLUGIN_SYNCED_SKILLS = Object.freeze([
	"hobo-setup",
	"hobo-deploy",
] as const);

export type SkillsLockExemptionOptions = {
	readonly neverLockSkillNames?: readonly string[];
};

function parseGitHubPath(path: string): { owner: string; repo: string } | null {
	const segments = path.split("/");
	if (segments.length === 3 && segments[2] === "") segments.pop();
	if (segments.length !== 2) return null;
	const owner = segments[0] ?? "";
	const repo = (segments[1] ?? "").replace(/\.git$/iu, "");
	for (const segment of [owner, repo]) {
		if (
			!/^[A-Za-z0-9_.-]+$/u.test(segment) ||
			segment === "." ||
			segment === ".."
		) {
			return null;
		}
	}
	return { owner, repo };
}

function parseGitHubOwnerRepo(
	source: string,
): { owner: string; repo: string } | null {
	const trimmed = source.trim();
	if (trimmed.length === 0) return null;
	if (/^github:/iu.test(trimmed)) {
		return parseGitHubPath(
			trimmed.replace(/^github:/iu, "").replace(/[?#].*$/u, ""),
		);
	}
	if (/^git@github\.com:/iu.test(trimmed)) {
		return parseGitHubPath(
			trimmed.replace(/^git@github\.com:/iu, "").replace(/[?#].*$/u, ""),
		);
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return parseGitHubPath(trimmed.replace(/[?#].*$/u, ""));
	}
	if (
		url.hostname.toLowerCase() !== "github.com" ||
		url.port !== "" ||
		url.password !== ""
	) {
		return null;
	}
	if (["http:", "https:", "git+http:", "git+https:"].includes(url.protocol)) {
		if (url.username !== "") return null;
	} else if (["ssh:", "git+ssh:"].includes(url.protocol)) {
		if (url.username !== "git") return null;
	} else {
		return null;
	}
	return parseGitHubPath(url.pathname.slice(1));
}

export async function skillsLockExemptionIssues(
	skillsRoot: string,
	repoRoot: string,
	options: SkillsLockExemptionOptions = {},
): Promise<readonly SkillConformanceIssue[]> {
	const neverLock = new Set([
		...HOBO_PORTABLE_PLUGIN_SYNCED_SKILLS,
		...(options.neverLockSkillNames ?? []),
	]);
	let text: string;
	try {
		text = await readFile(join(repoRoot, "skills-lock.json"), "utf8");
	} catch (error) {
		throw new SkillParseError(
			`skills-lock.json is required for HoBo-owned skill discovery (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new SkillParseError(
			`skills-lock.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: skills-lock.json is untrusted JSON; shallow object checks only. */
	if (typeof parsed !== "object" || parsed === null || !("skills" in parsed)) {
		return Object.freeze([]);
	}
	const skills = parsed.skills;
	if (typeof skills !== "object" || skills === null) {
		return Object.freeze([]);
	}
	const issues: SkillConformanceIssue[] = [];
	for (const [name, entry] of Object.entries(skills)) {
		if (neverLock.has(name)) {
			issues.push({
				skill: name,
				code: "lock-exempts-repo-skill",
				message:
					"skills-lock.json must not list a repo-authored skill that ships in the portable plugin",
			});
			continue;
		}
		let skillMdExists = false;
		try {
			await stat(join(skillsRoot, name, "SKILL.md"));
			skillMdExists = true;
		} catch (error) {
			if (!(error instanceof Error && isMissingFileError(error))) throw error;
			skillMdExists = false;
		}
		if (!skillMdExists || HOBO_REVIEWED_VENDORED_SKILL_NAMES.has(name)) {
			continue;
		}
		const lockedSkill: unknown = entry;
		let source: string | undefined;
		if (
			typeof lockedSkill === "object" &&
			lockedSkill !== null &&
			"source" in lockedSkill
		) {
			const lockedSource: unknown = lockedSkill.source;
			if (typeof lockedSource === "string") source = lockedSource;
		}
		const ownerRepo =
			source === undefined ? null : parseGitHubOwnerRepo(source);
		if (
			ownerRepo?.owner.toLowerCase() === "hobo-labs" &&
			ownerRepo.repo.toLowerCase() === "hobo"
		) {
			issues.push({
				skill: name,
				code: "lock-exempts-repo-skill",
				message:
					"skills-lock.json must not list an in-tree skill as vendored from Hobo-Labs/HoBo",
			});
			continue;
		}
		issues.push({
			skill: name,
			code: "lock-shadows-in-tree-skill",
			message:
				"skills-lock.json cannot reclassify an in-tree skill as vendored unless its name is in the reviewed vendored-skill allowlist",
		});
	}
	/* oxlint-enable anti-slop/no-runtime-typeof */
	return Object.freeze(issues);
}

export async function checkHoboRepoSkillsConformance(
	repoRoot: string,
	skillsRoot = join(repoRoot, ".agents/skills"),
	options: SkillsLockExemptionOptions = {},
): Promise<readonly SkillConformanceIssue[]> {
	const strictSkillNames = await discoverHoboOwnedSkillNames(
		skillsRoot,
		repoRoot,
	);
	const lockIssues = await skillsLockExemptionIssues(
		skillsRoot,
		repoRoot,
		options,
	);
	const skillIssues = await checkSkillsConformance(skillsRoot, {
		strictSkillNames,
	});
	return Object.freeze([...lockIssues, ...skillIssues]);
}

type YamlScalar =
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "null"; readonly value: null };

type FrontmatterFields = {
	readonly fields: ReadonlyMap<string, YamlScalar>;
	readonly children: ReadonlyMap<string, ReadonlyMap<string, YamlScalar>>;
	readonly deeplyNested: ReadonlySet<string>;
	readonly unrecognizedTopLevel: readonly string[];
};

function parseYamlScalar(value: string): YamlScalar {
	const scalar = value.trim();
	if (scalar.startsWith('"')) {
		if (scalar.length < 2 || !scalar.endsWith('"')) {
			throw new SkillParseError("invalid double-quoted YAML scalar");
		}
		try {
			return { kind: "string", value: String(JSON.parse(scalar)) };
		} catch {
			throw new SkillParseError("invalid double-quoted YAML scalar");
		}
	}
	if (scalar.startsWith("'")) {
		if (!/^'(?:[^']|'')*'$/u.test(scalar)) {
			throw new SkillParseError("invalid single-quoted YAML scalar");
		}
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
	const unrecognizedTopLevel: string[] = [];
	let currentNestedField: string | undefined;
	for (const line of match[1].split(/\r?\n/u)) {
		const top = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
		if (top && top[1] !== undefined && top[2] !== undefined) {
			if (fields.has(top[1])) {
				throw new SkillParseError("duplicate frontmatter field");
			}
			fields.set(top[1], parseYamlScalar(top[2]));
			currentNestedField =
				top[2].trim() === "" && top[1] !== "name" && top[1] !== "description"
					? top[1]
					: undefined;
			if (currentNestedField !== undefined)
				children.set(currentNestedField, new Map());
			continue;
		}
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		if (/^\S/u.test(line)) {
			currentNestedField = undefined;
			unrecognizedTopLevel.push(line);
			continue;
		}
		if (currentNestedField === undefined) {
			unrecognizedTopLevel.push(line);
			continue;
		}
		const child = /^ {2,}([^:\s]+):\s*(.*)$/u.exec(line);
		if (child && child[1] !== undefined && child[2] !== undefined) {
			if (/^ {4,}\S/u.test(line) || /^(?:\[|\{)/u.test(child[2].trim())) {
				deeplyNested.add(currentNestedField);
				continue;
			}
			const nested = children.get(currentNestedField);
			if (nested === undefined) continue;
			if (nested.has(child[1])) {
				throw new SkillParseError("duplicate nested frontmatter field");
			}
			nested.set(child[1], parseYamlScalar(child[2]));
		} else {
			deeplyNested.add(currentNestedField);
		}
	}
	return { fields, children, deeplyNested, unrecognizedTopLevel };
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
	for (const _line of frontmatter.unrecognizedTopLevel) {
		issues.push({
			skill,
			code: "unparseable",
			message: "unrecognized top-level YAML line",
		});
	}
	for (const field of frontmatter.fields.keys()) {
		if (!HOBO_OWNED_ALLOWED_FIELDS.includes(field)) {
			issues.push({
				skill,
				code: "disallowed-frontmatter-field",
				message: `frontmatter field is not in the allowed set (${HOBO_OWNED_ALLOWED_FIELDS.join(", ")})`,
			});
		}
	}
	const name = frontmatter.fields.get("name");
	if (name !== undefined && (name.kind !== "string" || name.value !== skill)) {
		issues.push({
			skill,
			code: "name-folder-mismatch",
			message: "frontmatter name does not match the skill folder name",
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
				message:
					"frontmatter field must be a scalar; nested blocks are only allowed under metadata",
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
		if (dirent.isSymbolicLink()) {
			throw new SkillParseError(
				`${dirent.name} must be a real skill directory, not a symbolic link`,
			);
		}
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
	const namedStrictSkills = options.strictSkillNames;
	const strictSkills = new Set(namedStrictSkills ?? []);
	const isStrict = (folder: string, name: string): boolean =>
		namedStrictSkills === undefined ||
		strictSkills.has(folder) ||
		strictSkills.has(name);
	const issues: SkillConformanceIssue[] = [];
	const seen = new Map<string, string>();
	for (const dirent of await readdir(root, { withFileTypes: true })) {
		if (dirent.isSymbolicLink()) {
			issues.push({
				skill: dirent.name,
				code: "missing-skill-md",
				message: `${dirent.name} must be a real skill directory, not a symbolic link`,
			});
			continue;
		}
		if (!dirent.isDirectory()) continue;
		const skillMd = join(root, dirent.name, "SKILL.md");
		let markdown: string;
		try {
			await stat(skillMd);
			markdown = await readFile(skillMd, "utf8");
		} catch (error) {
			if (!(error instanceof Error && isMissingFileError(error))) throw error;
			issues.push({
				skill: dirent.name,
				code: "missing-skill-md",
				message: `${dirent.name} has no SKILL.md`,
			});
			continue;
		}
		try {
			const parsed = parseSkillFrontmatter(markdown);
			if (isStrict(dirent.name, parsed.name)) {
				issues.push(...strictSkillIssues(dirent.name, markdown));
			}
			const prior = seen.get(parsed.name);
			if (prior !== undefined) {
				issues.push({
					skill: dirent.name,
					code: "duplicate-name",
					message: `skill name is also declared by folder "${prior}"`,
				});
			} else {
				seen.set(parsed.name, dirent.name);
			}
		} catch (error) {
			const strictIssues = isStrict(dirent.name, dirent.name)
				? strictSkillIssues(dirent.name, markdown)
				: [];
			issues.push(...strictIssues);
			if (!strictIssues.some((issue) => issue.code === "unparseable")) {
				issues.push({
					skill: dirent.name,
					code: "unparseable",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return Object.freeze(issues);
}
