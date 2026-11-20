import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { HOBO_OWNED_ALLOWED_FIELDS } from "@hobo/agent-skills";
import { z } from "zod";

import {
	defaultNbgvRunner,
	fixedTrainAlphaSemver,
	loadVersionJsonHeightConfig,
	type NbgvRunner,
} from "./lib/nbgv-release-version.mts";

export const PLUGIN_SCHEMA_ID =
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_ID =
	"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_NAME_PATTERN =
	/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const SEMVER_PATTERN =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const FORBIDDEN_ENV_KEYS = ["PLUGIN_ROOT", "PLUGIN_DATA"];
const SECRET_KEY_PATTERN =
	/(?:token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/iu;
export const SECRET_VALUE_PATTERN =
	/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/u;

export const PLUGIN_ALLOWED_SKILL_FIELDS = HOBO_OWNED_ALLOWED_FIELDS;
export const SYNCED_SKILLS = ["hobo-setup", "hobo-deploy"] as const;

export type AgentPluginIssue = {
	readonly file: string;
	readonly message: string;
};

export type AgentPluginReport = {
	readonly issues: readonly AgentPluginIssue[];
	readonly notes: readonly string[];
};

export const PluginAuthorSchema = z.strictObject({
	name: z.string(),
	email: z.string().optional(),
	url: z.string().optional(),
});

export const PluginManifestSchema = z.strictObject({
	$schema: z.string(),
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(
			PLUGIN_NAME_PATTERN,
			"name violates the 1.0.0 name grammar (lowercase alphanumerics, dot, dash; no double dash or double dot)",
		),
	version: z.string().regex(SEMVER_PATTERN, "version must be a semver string"),
	description: z.string().optional(),
	author: PluginAuthorSchema.optional(),
	homepage: z.string().optional(),
	repository: z.string().optional(),
	license: z.string().optional(),
	keywords: z.array(z.string()).optional(),
	extensions: z.record(z.string(), z.strictObject({})).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const McpStdioServerSchema = z.strictObject({
	type: z.literal("stdio"),
	command: z
		.string()
		.min(1)
		.regex(
			/^\S+$/u,
			"command must be a single executable token without whitespace",
		),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	cwd: z.string().optional(),
});

export const McpConfigSchema = z.strictObject({
	$schema: z.string(),
	mcpServers: z.record(z.string(), McpStdioServerSchema),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

function zodIssueToMessage(issue: z.core.$ZodIssue): string {
	const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
	if (issue.code === "unrecognized_keys" && "keys" in issue) {
		const keys = issue.keys ?? [];
		return `${where}field ${keys.map((key) => `"${key}"`).join(", ")} is not allowed by the schema's closed field set`;
	}
	return `${where}${issue.message}`;
}

type ParsedFile<T> = {
	readonly value: T | undefined;
	readonly issues: readonly AgentPluginIssue[];
};

function parseJsonWith<T>(
	file: string,
	schema: z.ZodType<T>,
	text: string,
): ParsedFile<T> {
	let parsed: ReturnType<JSON["parse"]>;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			value: undefined,
			issues: [
				{
					file,
					message: `cannot be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
	const result = schema.safeParse(parsed);
	if (result.success) return { value: result.data, issues: [] };
	return {
		value: undefined,
		issues: result.error.issues.map((issue) => ({
			file,
			message: zodIssueToMessage(issue),
		})),
	};
}

export function parsePluginManifest(text: string): ParsedFile<PluginManifest> {
	return parseJsonWith("plugin.json", PluginManifestSchema, text);
}

export function parseMcpConfig(text: string): ParsedFile<McpConfig> {
	return parseJsonWith("mcp.json", McpConfigSchema, text);
}

type SemverPrecedence = {
	readonly release: readonly [number, number, number];
	readonly prerelease: readonly string[];
};

function parseSemverPrecedence(version: string): SemverPrecedence {
	const withoutBuild = version.split("+", 1)[0] ?? version;
	const firstDash = withoutBuild.indexOf("-");
	const core =
		firstDash === -1 ? withoutBuild : withoutBuild.slice(0, firstDash);
	const prerelease =
		firstDash === -1 ? [] : withoutBuild.slice(firstDash + 1).split(".");
	const [major = Number.NaN, minor = Number.NaN, patch = Number.NaN] = core
		.split(".")
		.map(Number);
	if (
		!Number.isInteger(major) ||
		!Number.isInteger(minor) ||
		!Number.isInteger(patch) ||
		major < 0 ||
		minor < 0 ||
		patch < 0
	) {
		throw new Error(`not a semver version string: ${version}`);
	}
	return { release: [major, minor, patch], prerelease };
}

export function compareSemverPrecedence(a: string, b: string): number {
	const left = parseSemverPrecedence(a);
	const right = parseSemverPrecedence(b);
	for (let index = 0; index < 3; index++) {
		const leftPart = left.release[index] ?? 0;
		const rightPart = right.release[index] ?? 0;
		if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
	}
	if (left.prerelease.length === 0 || right.prerelease.length === 0) {
		if (left.prerelease.length === right.prerelease.length) return 0;
		return left.prerelease.length === 0 ? 1 : -1;
	}
	const shared = Math.min(left.prerelease.length, right.prerelease.length);
	for (let index = 0; index < shared; index++) {
		const leftField = left.prerelease[index] ?? "";
		const rightField = right.prerelease[index] ?? "";
		if (leftField === rightField) continue;
		const leftNumeric = /^\d+$/u.test(leftField);
		const rightNumeric = /^\d+$/u.test(rightField);
		if (leftNumeric && rightNumeric) {
			const leftValue = Number(leftField);
			const rightValue = Number(rightField);
			if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
			continue;
		}
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return leftField < rightField ? -1 : 1;
	}
	if (left.prerelease.length !== right.prerelease.length)
		return left.prerelease.length < right.prerelease.length ? -1 : 1;
	return 0;
}

export function manifestSemanticIssues(
	manifest: PluginManifest,
	versionFromReleaseTrain?: string | undefined,
	options: { readonly exactReleaseTrain?: boolean } = {},
): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	if (manifest.$schema !== PLUGIN_SCHEMA_ID) {
		issues.push({
			file: "plugin.json",
			message: `$schema must be exactly ${PLUGIN_SCHEMA_ID}`,
		});
	}
	if (versionFromReleaseTrain !== undefined) {
		if (!/^0\.0\.0-alpha\.(?:0|[1-9]\d*)$/u.test(manifest.version)) {
			issues.push({
				file: "plugin.json",
				message: `version ${manifest.version} must stay on the fixed alpha train 0.0.0-alpha.<height>`,
			});
		} else {
			const comparison = compareSemverPrecedence(
				manifest.version,
				versionFromReleaseTrain,
			);
			if (comparison < 0) {
				issues.push({
					file: "plugin.json",
					message: `version ${manifest.version} is stale: the release train for the checked commit is ${versionFromReleaseTrain}; update it (scripts/ci/compute-release-version.mts)`,
				});
			} else if (comparison > 0 && options.exactReleaseTrain === true) {
				issues.push({
					file: "plugin.json",
					message: `version ${manifest.version} is newer than the release train ${versionFromReleaseTrain}; PR and merge-group validation require an exact pin; update it (scripts/ci/compute-release-version.mts)`,
				});
			}
		}
	}
	return issues;
}

export function mcpSemanticIssues(config: McpConfig): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	if (config.$schema !== MCP_SCHEMA_ID) {
		issues.push({
			file: "mcp.json",
			message: `$schema must be exactly ${MCP_SCHEMA_ID}`,
		});
	}
	for (const [serverName, server] of Object.entries(config.mcpServers)) {
		const where = `mcp.json mcpServers.${serverName}`;
		for (const arg of server.args ?? []) {
			issues.push(...checkPluginScopedPath(where, arg));
		}
		if (server.cwd !== undefined) {
			issues.push(...checkPluginScopedPath(where, server.cwd));
		}
		for (const key of Object.keys(server.env ?? {})) {
			if (FORBIDDEN_ENV_KEYS.includes(key)) {
				issues.push({
					file: where,
					message: `env key "${key}" is reserved by the specification`,
				});
			}
			if (SECRET_KEY_PATTERN.test(key)) {
				issues.push({
					file: where,
					message: `env key "${key}" names a secret; never commit its value`,
				});
			}
		}
	}
	return issues;
}

export function checkPluginScopedPath(
	where: string,
	value: string,
): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	const rooted = value.replace(/\$\{PLUGIN_(?:ROOT|DATA)\}/gu, "<root>");
	if (SECRET_VALUE_PATTERN.test(rooted)) {
		issues.push({
			file: where,
			message: "path looks like it embeds a secret value",
		});
	}
	if (rooted.split(/[\\/]/u).includes("..")) {
		issues.push({
			file: where,
			message: "plugin-scoped path must not traverse outside the plugin root",
		});
	}
	if (
		path.isAbsolute(value) ||
		path.win32.isAbsolute(value) ||
		/^~(?:[\\/]|$)/u.test(value)
	) {
		issues.push({
			file: where,
			message:
				"plugin-scoped path must be relative or rooted at PLUGIN_ROOT or PLUGIN_DATA, not absolute or home-relative",
		});
	}
	return issues;
}

export function scanTextForSecrets(
	file: string,
	text: string,
): AgentPluginIssue[] {
	return SECRET_VALUE_PATTERN.test(text)
		? [
				{
					file,
					message: "contains a secret-shaped value; never commit credentials",
				},
			]
		: [];
}

export function checkMarkdownLinks(
	pluginRoot: string,
	relativeFile: string,
): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	const file = path.join(pluginRoot, relativeFile);
	const text = readFileSync(file, "utf8");
	const dir = path.dirname(file);
	for (const match of text.matchAll(
		/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu,
	)) {
		const target = match[1];
		if (target === undefined) continue;
		if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("#"))
			continue;
		const withoutAnchor = target.split("#", 1)[0] ?? target;
		if (withoutAnchor === "") continue;
		const resolved = path.resolve(dir, withoutAnchor);
		const contained =
			resolved === pluginRoot ||
			resolved.startsWith(`${pluginRoot}${path.sep}`);
		if (!contained) {
			issues.push({
				file: relativeFile,
				message: `relative link "${target}" resolves outside the plugin root`,
			});
		}
	}
	return issues;
}

export function parseFrontmatterBlock(
	markdown: string,
): Map<string, string> | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown);
	if (!match || match[1] === undefined) return undefined;
	const fields = new Map<string, string>();
	for (const line of match[1].split(/\r?\n/u)) {
		const field = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
		if (field && field[1] !== undefined && field[2] !== undefined) {
			fields.set(field[1], field[2].trim());
		}
	}
	return fields;
}

export function bodyAfterFrontmatter(markdown: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(markdown);
	return match ? markdown.slice(match[0].length) : markdown;
}

export const AGENT_TOOLING_HEADING =
	"### hobo — HoBo's own MCP server (this repo)";
export const AGENT_TOOLING_DOCS_FILE = "docs/agent-tooling.md";
export const AGENT_TOOLING_REFERENCE_FILE = path.join(
	"skills",
	"hobo-setup",
	"references",
	"agent-tooling.md",
);
const HOBO_SETUP_REPO_DIR = ".agents/skills/hobo-setup";
const HOBO_SETUP_PLUGIN_DIR = "skills/hobo-setup";
const REPO_ONLY_MARKERS: readonly string[] = [
	" (repo-only: it lives in the HoBo repository)",
	" (repo-only)",
];

export function extractMarkdownSection(
	markdown: string,
	heading: string,
): string | undefined {
	const lines = markdown.split(/\r?\n/u);
	const start = lines.indexOf(heading);
	if (start === -1) return undefined;
	const end = lines.findIndex(
		(line, index) => index > start && /^#{1,3} \S/u.test(line),
	);
	return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function docsLinkTargetToPluginRelative(target: string): string {
	const [pathPart, ...anchorParts] = target.split("#");
	if (pathPart === undefined || pathPart === "") return target;
	if (/^[a-z][a-z0-9+.-]*:/iu.test(pathPart)) return target;
	const resolved = path.posix.normalize(path.posix.join("docs", pathPart));
	if (
		resolved !== HOBO_SETUP_REPO_DIR &&
		!resolved.startsWith(`${HOBO_SETUP_REPO_DIR}/`)
	) {
		return target;
	}
	const withinSetup = path.posix.relative(HOBO_SETUP_REPO_DIR, resolved);
	const fromReference = path.posix.relative(
		path.posix.join(HOBO_SETUP_PLUGIN_DIR, "references"),
		path.posix.join(HOBO_SETUP_PLUGIN_DIR, withinSetup),
	);
	const anchor = anchorParts.length > 0 ? `#${anchorParts.join("#")}` : "";
	return `${fromReference}${anchor}`;
}

function rewriteDocsLinksForPlugin(section: string): string {
	return section.replace(
		/\]\(([^)\s]+)(\s+"[^"]*")?\)/gu,
		(_match, target: string, title?: string) =>
			`](${docsLinkTargetToPluginRelative(target)}${title ?? ""})`,
	);
}

function dropSourceParagraph(text: string): string {
	const match = /^Source:[^\n]*(?:\n[^\n]+)*(?:\n|$)/u.exec(text);
	return match && match[0] !== undefined ? text.slice(match[0].length) : text;
}

function stripRepoOnlyMarkers(text: string): string {
	let stripped = text;
	for (const marker of [...REPO_ONLY_MARKERS].sort(
		(a, b) => b.length - a.length,
	)) {
		stripped = stripped.replaceAll(marker, "");
	}
	return stripped;
}

function collapseForComparison(text: string): string {
	return text.trim().split(/\s+/u).join(" ");
}

function divergenceContext(expected: string, actual: string): string {
	let index = 0;
	while (
		index < expected.length &&
		index < actual.length &&
		expected[index] === actual[index]
	) {
		index++;
	}
	const window = (text: string): string => {
		const start = Math.max(0, index - 30);
		return text.slice(start, start + 50) || "(end of text)";
	};
	return `docs reads "...${window(expected)}...", reference reads "...${window(actual)}..."`;
}

export function agentToolingReferenceDriftIssues(input: {
	docsMarkdown: string;
	referenceMarkdown: string;
	referenceFile?: string | undefined;
}): AgentPluginIssue[] {
	const file = input.referenceFile ?? AGENT_TOOLING_REFERENCE_FILE;
	const section = extractMarkdownSection(
		input.docsMarkdown,
		AGENT_TOOLING_HEADING,
	);
	if (section === undefined) {
		return [
			{
				file: AGENT_TOOLING_DOCS_FILE,
				message: `section "${AGENT_TOOLING_HEADING}" is missing, so ${file} cannot be verified against it`,
			},
		];
	}
	const referenceLines = input.referenceMarkdown.split(/\r?\n/u);
	if (referenceLines[0] !== AGENT_TOOLING_HEADING) {
		return [
			{
				file,
				message: `must start with the heading "${AGENT_TOOLING_HEADING}" to stay identifiable as an extract of ${AGENT_TOOLING_DOCS_FILE}`,
			},
		];
	}
	const referenceBody = collapseForComparison(
		stripRepoOnlyMarkers(
			dropSourceParagraph(referenceLines.slice(1).join("\n").trimStart()),
		),
	);
	const docsBody = collapseForComparison(rewriteDocsLinksForPlugin(section));
	if (referenceBody === docsBody) return [];
	return [
		{
			file,
			message: `drifted from ${AGENT_TOOLING_DOCS_FILE} section "${AGENT_TOOLING_HEADING}"; re-extract the section, rewrite .agents/skills/hobo-setup links plugin-relative, and keep the repo-only markers (${divergenceContext(docsBody, referenceBody)})`,
		},
	];
}

function agentToolingDocsDriftIssues(
	repoRoot: string,
	pluginRoot: string,
): AgentPluginIssue[] {
	const referenceFile = path.join(pluginRoot, AGENT_TOOLING_REFERENCE_FILE);
	if (!existsSync(referenceFile)) {
		return [
			{
				file: AGENT_TOOLING_REFERENCE_FILE,
				message: `is missing; hobo-setup must ship the ${AGENT_TOOLING_DOCS_FILE} extract`,
			},
		];
	}
	const docsFile = path.join(repoRoot, AGENT_TOOLING_DOCS_FILE);
	if (!existsSync(docsFile)) {
		return [
			{
				file: AGENT_TOOLING_REFERENCE_FILE,
				message: `${AGENT_TOOLING_DOCS_FILE} is missing from the repo root`,
			},
		];
	}
	return agentToolingReferenceDriftIssues({
		docsMarkdown: readFileSync(docsFile, "utf8"),
		referenceMarkdown: readFileSync(referenceFile, "utf8"),
	});
}

function skillIssues(
	pluginRoot: string,
	repoSkillsRoot: string,
	skill: string,
): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	const relativeFile = path.join("skills", skill, "SKILL.md");
	const pluginFile = path.join(pluginRoot, relativeFile);
	if (!existsSync(pluginFile)) {
		issues.push({ file: relativeFile, message: "is missing from the plugin" });
		return issues;
	}
	const pluginMarkdown = readFileSync(pluginFile, "utf8");
	const fields = parseFrontmatterBlock(pluginMarkdown);
	if (fields === undefined) {
		issues.push({ file: relativeFile, message: "has no frontmatter block" });
		return issues;
	}
	for (const field of fields.keys()) {
		if (!PLUGIN_ALLOWED_SKILL_FIELDS.includes(field)) {
			issues.push({
				file: relativeFile,
				message: `frontmatter field "${field}" is not allowed (allowed: ${PLUGIN_ALLOWED_SKILL_FIELDS.join(", ")})`,
			});
		}
	}
	const name = fields.get("name");
	if (name !== skill) {
		issues.push({
			file: relativeFile,
			message: `frontmatter name must equal the folder name "${skill}"`,
		});
	}
	const repoFile = path.join(repoSkillsRoot, skill, "SKILL.md");
	if (!existsSync(repoFile)) {
		issues.push({
			file: relativeFile,
			message: `repo source .agents/skills/${skill}/SKILL.md is missing`,
		});
		return issues;
	}
	const repoMarkdown = readFileSync(repoFile, "utf8");
	const repoFields = parseFrontmatterBlock(repoMarkdown);
	for (const field of ["name", "description"]) {
		if (fields.get(field) !== repoFields?.get(field)) {
			issues.push({
				file: relativeFile,
				message: `${field} drifted from .agents/skills/${skill}/SKILL.md; copy the repo frontmatter value`,
			});
		}
	}
	if (
		bodyAfterFrontmatter(pluginMarkdown) !== bodyAfterFrontmatter(repoMarkdown)
	) {
		issues.push({
			file: relativeFile,
			message: `body drifted from .agents/skills/${skill}/SKILL.md; copy the repo body and keep only the frontmatter extension`,
		});
	}
	issues.push(...scanTextForSecrets(relativeFile, pluginMarkdown));
	issues.push(...checkMarkdownLinks(pluginRoot, relativeFile));

	const pluginSkillDir = path.join(pluginRoot, "skills", skill);
	const repoSkillDir = path.join(repoSkillsRoot, skill);
	if (existsSync(pluginSkillDir) && existsSync(repoSkillDir)) {
		for (const entry of readFrontmatterReferenceDirs(repoSkillDir)) {
			const pluginReference = path.join(pluginSkillDir, entry);
			for (const name of readMarkdownNames(path.join(repoSkillDir, entry))) {
				const pluginText = readFileSync(
					path.join(pluginReference, name),
					"utf8",
				);
				const repoText = readFileSync(
					path.join(repoSkillDir, entry, name),
					"utf8",
				);
				if (pluginText !== repoText) {
					issues.push({
						file: path.join("skills", skill, entry, name),
						message: `drifted from .agents/skills/${skill}/${entry}/${name}; copy the repo file`,
					});
				}
			}
		}
	}
	return issues;
}

function readFrontmatterReferenceDirs(skillDir: string): string[] {
	return readdirSync(skillDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

function readMarkdownNames(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.endsWith(".md"));
}

function vendoredSchemaIssues(repoRoot: string): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	const dir = path.join(repoRoot, "tools/agent-plugins/schemas/1.0.0");
	for (const [file, id] of [
		["plugin.schema.json", PLUGIN_SCHEMA_ID],
		["mcp.schema.json", MCP_SCHEMA_ID],
	] as const) {
		const full = path.join(dir, file);
		if (!existsSync(full)) {
			issues.push({
				file,
				message:
					"vendored schema is missing under tools/agent-plugins/schemas/1.0.0",
			});
			continue;
		}
		const schema = PluginVendoredSchema.safeParse(
			JSON.parse(readFileSync(full, "utf8")),
		);
		if (!schema.success || schema.data.$id !== id) {
			issues.push({
				file,
				message: `vendored copy must declare "$id": "${id}"`,
			});
		}
	}
	return issues;
}

const PluginVendoredSchema = z.object({ $id: z.string() });

export function checkAgentPlugin(input: {
	pluginRoot: string;
	repoRoot: string;
	versionFromReleaseTrain?: string | undefined;
}): AgentPluginReport {
	const { pluginRoot, repoRoot } = input;
	const issues: AgentPluginIssue[] = [];
	const notes: string[] = [];

	const manifestText = readPluginFile(pluginRoot, "plugin.json", issues);
	if (manifestText !== undefined) {
		const manifest = parsePluginManifest(manifestText);
		issues.push(...manifest.issues);
		if (manifest.value !== undefined) {
			issues.push(
				...manifestSemanticIssues(
					manifest.value,
					input.versionFromReleaseTrain,
					{ exactReleaseTrain: requiresExactReleaseTrainVersion(repoRoot) },
				),
			);
		}
		issues.push(...scanTextForSecrets("plugin.json", manifestText));
	}
	const mcpText = readPluginFile(pluginRoot, "mcp.json", issues);
	if (mcpText !== undefined) {
		const mcp = parseMcpConfig(mcpText);
		issues.push(...mcp.issues);
		if (mcp.value !== undefined) issues.push(...mcpSemanticIssues(mcp.value));
		issues.push(...scanTextForSecrets("mcp.json", mcpText));
	}
	issues.push(...vendoredSchemaIssues(repoRoot));

	const skillsDir = path.join(pluginRoot, "skills");
	const shipped = existsSync(skillsDir)
		? readFrontmatterReferenceDirs(skillsDir).sort()
		: [];
	const expected = [...SYNCED_SKILLS].sort();
	if (JSON.stringify(shipped) !== JSON.stringify(expected)) {
		issues.push({
			file: "skills",
			message: `plugin ships ${JSON.stringify(shipped)} but the portable set is exactly ${JSON.stringify(expected)}; repo-internal skills (verify-*, TLA+/vitest harnesses) must not ship`,
		});
	}
	for (const skill of SYNCED_SKILLS) {
		issues.push(
			...skillIssues(pluginRoot, path.join(repoRoot, ".agents/skills"), skill),
		);
	}
	issues.push(...agentToolingDocsDriftIssues(repoRoot, pluginRoot));

	const readmeText = readPluginFile(pluginRoot, "README.md", issues);
	if (readmeText !== undefined) {
		issues.push(...checkMarkdownLinks(pluginRoot, "README.md"));
		issues.push(...scanTextForSecrets("README.md", readmeText));
	}

	const bundle = path.join(pluginRoot, "bin/hobo-mcp.mjs");
	if (existsSync(bundle)) {
		const size = statSync(bundle).size;
		if (size < 1024 * 1024) {
			issues.push({
				file: "bin/hobo-mcp.mjs",
				message: `exists but is only ${size} bytes; a real bundle of the composed server is megabytes — rebuild with pnpm run agent-plugin:build`,
			});
		}
	} else {
		notes.push(
			"agent-plugin:check: bin/hobo-mcp.mjs not built yet (pnpm run agent-plugin:build); validated committed wiring only",
		);
	}
	return { issues, notes };
}

function readPluginFile(
	pluginRoot: string,
	file: string,
	issues: AgentPluginIssue[],
): string | undefined {
	const full = path.join(pluginRoot, file);
	if (!existsSync(full)) {
		issues.push({ file, message: "is missing" });
		return undefined;
	}
	return readFileSync(full, "utf8");
}

function pluginManifestStaged(repoRoot: string): boolean {
	const result = spawnSync(
		"git",
		["diff", "--cached", "--name-only", "--", "plugins/hobo/plugin.json"],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	return result.status === 0 && (result.stdout ?? "").trim().length > 0;
}

export function versionPinCommitIsh(repoRoot: string): string {
	const headSha = process.env.GITHUB_HEAD_SHA?.trim();
	if (headSha !== undefined && headSha.length > 0) return headSha;
	const eventName = process.env.GITHUB_EVENT_NAME?.trim();
	if (eventName === "pull_request" || eventName === "merge_group") {
		const prHead = spawnSync("git", ["rev-parse", "HEAD^2"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		const sha = prHead.stdout?.trim() ?? "";
		if (prHead.status === 0 && sha.length > 0) return sha;
	}
	return "HEAD";
}

export function requiresExactReleaseTrainVersion(
	repoRoot: string,
	commitIsh = versionPinCommitIsh(repoRoot),
): boolean {
	const eventName = process.env.GITHUB_EVENT_NAME?.trim();
	if (eventName === "pull_request" || eventName === "merge_group") return true;
	if (commitIsh === "HEAD") return false;
	const mergeHead = spawnSync("git", ["rev-parse", "HEAD^2"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return mergeHead.status === 0 && mergeHead.stdout?.trim() === commitIsh;
}

export function releaseTrainSemverForPluginCheck(
	repoRoot: string,
	nbgv: NbgvRunner = defaultNbgvRunner(repoRoot),
): string {
	const config = loadVersionJsonHeightConfig(repoRoot);
	const commitIsh = versionPinCommitIsh(repoRoot);
	const height = Number(nbgv("VersionHeight", commitIsh));
	if (!Number.isInteger(height) || height < 0) {
		throw new Error(`invalid VersionHeight at ${commitIsh}: ${height}`);
	}
	const bump = commitIsh === "HEAD" && pluginManifestStaged(repoRoot) ? 1 : 0;
	return fixedTrainAlphaSemver(height + bump, config);
}

export function releaseTrainVersionForPluginGate(
	repoRoot: string,
	nbgv: NbgvRunner = defaultNbgvRunner(repoRoot),
): string | undefined {
	try {
		return releaseTrainSemverForPluginCheck(repoRoot, nbgv);
	} catch (error) {
		const allowLocalSkip =
			process.env.HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN === "1" &&
			!process.env.CI &&
			!process.env.GITHUB_ACTIONS &&
			!process.env.TF_BUILD;
		if (!allowLocalSkip) throw error;
		return undefined;
	}
}

function main(): void {
	const repoRoot = path.resolve(import.meta.dirname, "..");
	const versionFromReleaseTrain = releaseTrainVersionForPluginGate(repoRoot);
	if (versionFromReleaseTrain === undefined) {
		console.log(
			"agent-plugin:check: skipped the release-train comparison only because HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN=1 was set outside CI",
		);
	}
	const report = checkAgentPlugin({
		pluginRoot: path.join(repoRoot, "plugins/hobo"),
		repoRoot,
		versionFromReleaseTrain,
	});
	for (const note of report.notes) console.log(note);
	if (report.issues.length > 0) {
		console.error("agent-plugin gate failed:");
		for (const issue of report.issues) {
			console.error(`  - ${issue.file}: ${issue.message}`);
		}
		process.exit(1);
	}
	console.log(
		`agent plugin OK: plugins/hobo validated against Agent Plugins 1.0.0 (${SYNCED_SKILLS.length} synced skills).`,
	);
}

const invokedDirectly =
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
