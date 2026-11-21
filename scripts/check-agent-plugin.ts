import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const MCP_ENTRYPOINT = "${PLUGIN_ROOT}/bin/hobo-mcp.mjs";
const BUNDLE_ATTESTATION = ".bundle-attestation.json";
const SECRET_KEY_PATTERN =
	/(?:token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/iu;
export const SECRET_VALUE_PATTERN =
	/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/u;

export const PLUGIN_ALLOWED_SKILL_FIELDS = HOBO_OWNED_ALLOWED_FIELDS;
export const SYNCED_SKILLS = ["hobo-setup", "hobo-deploy"] as const;

export function agentPluginCiActive(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return [env.CI, env.GITHUB_ACTIONS, env.TF_BUILD].some((value) => {
		const set = (value ?? "").toLowerCase();
		return set !== "" && set !== "false" && set !== "0";
	});
}

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
				const eventName = process.env.GITHUB_EVENT_NAME?.trim();
				const manifestHeight = FIXED_ALPHA_HEIGHT_PATTERN.exec(
					manifest.version,
				)?.[1];
				const trainHeight = FIXED_ALPHA_HEIGHT_PATTERN.exec(
					versionFromReleaseTrain,
				)?.[1];
				const squashMergeLag =
					eventName === "push" &&
					options.exactReleaseTrain !== true &&
					manifestHeight !== undefined &&
					trainHeight !== undefined &&
					Number(manifestHeight) === Number(trainHeight) - 1;
				if (!squashMergeLag) {
					issues.push({
						file: "plugin.json",
						message: `version ${manifest.version} is stale: the release train for the checked commit is ${versionFromReleaseTrain}; update it (scripts/ci/compute-release-version.mts)`,
					});
				}
			} else if (comparison > 0) {
				const eventName = process.env.GITHUB_EVENT_NAME?.trim();
				const exact =
					options.exactReleaseTrain === true ||
					eventName === "pull_request" ||
					eventName === "merge_group";
				issues.push({
					file: "plugin.json",
					message: exact
						? `version ${manifest.version} is newer than the release train ${versionFromReleaseTrain}; PR and merge-group validation require an exact pin; update it (scripts/ci/compute-release-version.mts)`
						: `version ${manifest.version} is newer than the release train ${versionFromReleaseTrain} for the checked commit; ahead-of-train pins are never allowed outside the explicit one-height squash lag on push`,
				});
			}
		}
	}
	return issues;
}

export function hoboMcpServerIssues(config: McpConfig): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	const names = Object.keys(config.mcpServers);
	if (names.length !== 1 || names[0] !== "hobo") {
		issues.push({
			file: "mcp.json",
			message: `mcpServers must contain exactly the hobo server; found ${JSON.stringify(names.sort())}`,
		});
		return issues;
	}
	const hobo = config.mcpServers.hobo;
	if (hobo === undefined) return issues;
	if (hobo.command !== "node") {
		issues.push({
			file: "mcp.json",
			message: "hobo MCP server command must be exactly node",
		});
	}
	const args = hobo.args ?? [];
	if (args.length !== 1 || args[0] !== MCP_ENTRYPOINT) {
		issues.push({
			file: "mcp.json",
			message: `hobo MCP server must run node with a single argument ${MCP_ENTRYPOINT}`,
		});
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
		for (const [key, value] of Object.entries(server.env ?? {})) {
			issues.push(...scanTextForSecrets(`${where} env.${key}`, value));
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
	for (const relative of listFilesRecursive(pluginSkillDir)) {
		if (relative === "SKILL.md") continue;
		const relativeFile = path.join("skills", skill, relative);
		const repoFile = path.join(repoSkillDir, relative);
		if (!existsSync(repoFile)) {
			issues.push({
				file: relativeFile,
				message: `is shipped in the plugin but has no mirrored .agents/skills/${skill} source; add it to the repo skill or remove it here`,
			});
			continue;
		}
		const pluginText = readFileSync(
			path.join(pluginSkillDir, relative),
			"utf8",
		);
		if (pluginText !== readFileSync(repoFile, "utf8")) {
			issues.push({
				file: relativeFile,
				message: `drifted from .agents/skills/${skill}/${relative}; copy the repo file`,
			});
		}
		issues.push(...scanTextForSecrets(relativeFile, pluginText));
	}
	return issues;
}

function listFilesRecursive(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			for (const nested of listFilesRecursive(path.join(dir, entry.name))) {
				files.push(path.join(entry.name, nested));
			}
		} else {
			files.push(entry.name);
		}
	}
	return files;
}

function listSubdirectories(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

const VENDORED_SCHEMA_MANIFEST = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/u;
const PINNED_VENDORED_SCHEMA_FILES = [
	"plugin.schema.json",
	"mcp.schema.json",
] as const;
const FIXED_ALPHA_HEIGHT_PATTERN = /^0\.0\.0-alpha\.(\d+)$/u;

function sha256File(full: string): string {
	return createHash("sha256").update(readFileSync(full)).digest("hex");
}

function vendoredSchemaIssues(repoRoot: string): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	const dir = path.join(repoRoot, "tools/agent-plugins/schemas/1.0.0");
	const manifestPath = path.join(dir, "MANIFEST.sha256");
	const expectedDigests = new Map<string, string>();
	if (!existsSync(manifestPath)) {
		issues.push({
			file: "tools/agent-plugins/schemas/1.0.0/MANIFEST.sha256",
			message: "is missing; vendored schema digests must stay pinned",
		});
	} else {
		for (const line of readFileSync(manifestPath, "utf8").split("\n")) {
			if (line === "") continue;
			const [, digest, name] = VENDORED_SCHEMA_MANIFEST.exec(line) ?? [];
			if (digest === undefined || name === undefined) {
				issues.push({
					file: "tools/agent-plugins/schemas/1.0.0/MANIFEST.sha256",
					message: `has invalid line ${JSON.stringify(line)}`,
				});
				continue;
			}
			let pinnedName = false;
			for (const pinned of PINNED_VENDORED_SCHEMA_FILES) {
				if (name === pinned) {
					pinnedName = true;
					break;
				}
			}
			if (!pinnedName) {
				issues.push({
					file: "tools/agent-plugins/schemas/1.0.0/MANIFEST.sha256",
					message: `lists unexpected file ${JSON.stringify(name)}`,
				});
				continue;
			}
			expectedDigests.set(name, digest);
		}
		for (const file of PINNED_VENDORED_SCHEMA_FILES) {
			if (!expectedDigests.has(file)) {
				issues.push({
					file: "tools/agent-plugins/schemas/1.0.0/MANIFEST.sha256",
					message: `missing digest entry for ${file}`,
				});
			}
		}
	}
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
		const expected = expectedDigests.get(file);
		if (existsSync(manifestPath)) {
			if (expected === undefined) {
				issues.push({
					file: `tools/agent-plugins/schemas/1.0.0/${file}`,
					message: "has no MANIFEST.sha256 digest entry",
				});
			} else {
				const actual = sha256File(full);
				if (actual !== expected) {
					issues.push({
						file: `tools/agent-plugins/schemas/1.0.0/${file}`,
						message: `digest ${actual} does not match MANIFEST.sha256 (${expected})`,
					});
				}
			}
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

	const commitIsh = versionPinCommitIsh(repoRoot);
	const exactReleaseTrain = requiresExactReleaseTrainVersion(
		repoRoot,
		commitIsh,
	);
	if (input.versionFromReleaseTrain === undefined && agentPluginCiActive()) {
		issues.push({
			file: "plugin.json",
			message:
				"release-train version could not be computed in CI; fix version.json/nbgv or unset HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN",
		});
	}
	if (input.versionFromReleaseTrain !== undefined && !exactReleaseTrain) {
		notes.push(
			`agent-plugin:check: release-train comparison ran with exactReleaseTrain=false (GITHUB_EVENT_NAME=${process.env.GITHUB_EVENT_NAME?.trim() || "unset"}, commitIsh=${commitIsh}); only the one-height squash lag can waive a stale pin on push`,
		);
	}

	const manifestText = readPluginFile(pluginRoot, "plugin.json", issues);
	if (manifestText !== undefined) {
		const manifest = parsePluginManifest(manifestText);
		issues.push(...manifest.issues);
		if (manifest.value !== undefined) {
			issues.push(
				...manifestSemanticIssues(
					manifest.value,
					input.versionFromReleaseTrain,
					{ exactReleaseTrain },
				),
			);
		}
		issues.push(...scanTextForSecrets("plugin.json", manifestText));
	}
	const mcpText = readPluginFile(pluginRoot, "mcp.json", issues);
	if (mcpText !== undefined) {
		const mcp = parseMcpConfig(mcpText);
		issues.push(...mcp.issues);
		if (mcp.value !== undefined) {
			issues.push(...mcpSemanticIssues(mcp.value));
			issues.push(...hoboMcpServerIssues(mcp.value));
		}
		issues.push(...scanTextForSecrets("mcp.json", mcpText));
	}
	issues.push(...vendoredSchemaIssues(repoRoot));

	const skillsDir = path.join(pluginRoot, "skills");
	const shipped = existsSync(skillsDir)
		? listSubdirectories(skillsDir).sort()
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

	const bundle = path.resolve(
		pluginRoot,
		MCP_ENTRYPOINT.replace("${PLUGIN_ROOT}/", ""),
	);
	if (existsSync(bundle)) {
		issues.push(
			...scanTextForSecrets("bin/hobo-mcp.mjs", readFileSync(bundle, "utf8")),
		);
		const size = statSync(bundle).size;
		if (size < 1024 * 1024) {
			issues.push({
				file: "bin/hobo-mcp.mjs",
				message: `exists but is only ${size} bytes; a real bundle of the composed server is megabytes — rebuild with pnpm run agent-plugin:build`,
			});
		}
		issues.push(...bundleAttestationIssues(pluginRoot, bundle));
		const deployFixtures = path.join(pluginRoot, "fixtures/deploy");
		if (
			!existsSync(deployFixtures) ||
			listFilesRecursive(deployFixtures).length === 0
		) {
			issues.push({
				file: "fixtures/deploy",
				message:
					"is missing or empty while bin/hobo-mcp.mjs is present; rebuild with pnpm run agent-plugin:build",
			});
		}
	} else if (agentPluginCiActive()) {
		issues.push({
			file: "bin/hobo-mcp.mjs",
			message: "is missing in CI; build it with pnpm run agent-plugin:build",
		});
	} else {
		notes.push(
			"agent-plugin:check: bin/hobo-mcp.mjs not built yet (pnpm run agent-plugin:build); validated committed wiring only",
		);
	}
	return { issues, notes };
}

function bundleAttestationIssues(
	pluginRoot: string,
	bundlePath: string,
): AgentPluginIssue[] {
	if (process.env.GITHUB_ACTIONS !== "true") return [];
	const attestationPath = path.join(pluginRoot, BUNDLE_ATTESTATION);
	if (!existsSync(attestationPath)) {
		return [
			{
				file: "bin/hobo-mcp.mjs",
				message:
					"exists in CI without a bundle attestation; run pnpm run agent-plugin:build in this job before agent-plugin:check",
			},
		];
	}
	let attestationJson: unknown;
	try {
		attestationJson = JSON.parse(readFileSync(attestationPath, "utf8"));
	} catch {
		return [
			{
				file: BUNDLE_ATTESTATION,
				message:
					"is not valid JSON; run pnpm run agent-plugin:build in this CI job",
			},
		];
	}
	const attestation = z
		.strictObject({
			sha256: z.string().min(1),
			runId: z.string().min(1),
			commitSha: z.string().min(1),
			runAttempt: z.string().optional(),
		})
		.safeParse(attestationJson);
	if (!attestation.success) {
		return [
			{
				file: BUNDLE_ATTESTATION,
				message:
					"is not a valid bundle attestation; run pnpm run agent-plugin:build in this CI job",
			},
		];
	}
	const runId = process.env.GITHUB_RUN_ID?.trim();
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim();
	if (runId === undefined || runId.length === 0) {
		return [
			{
				file: BUNDLE_ATTESTATION,
				message:
					"bundle attestation is only trusted in a GitHub Actions job with GITHUB_RUN_ID; rebuild in CI before agent-plugin:check",
			},
		];
	}
	if (attestation.data.runId.length === 0) {
		return [
			{
				file: BUNDLE_ATTESTATION,
				message:
					"bundle attestation is missing runId; run pnpm run agent-plugin:build in this job",
			},
		];
	}
	const commitSha = process.env.GITHUB_SHA?.trim();
	if (commitSha === undefined || commitSha.length === 0) {
		return [
			{
				file: BUNDLE_ATTESTATION,
				message:
					"bundle attestation is only trusted in a GitHub Actions job with GITHUB_SHA; rebuild in CI before agent-plugin:check",
			},
		];
	}
	if (attestation.data.commitSha !== commitSha) {
		return [
			{
				file: BUNDLE_ATTESTATION,
				message:
					"bundle attestation commitSha does not match this workflow checkout; rebuild with pnpm run agent-plugin:build in this job",
			},
		];
	}
	if (attestation.data.runId !== runId) {
		return [
			{
				file: BUNDLE_ATTESTATION,
				message:
					"bundle attestation runId does not match this workflow run; rebuild with pnpm run agent-plugin:build in this job",
			},
		];
	}
	if (runAttempt !== undefined && runAttempt.length > 0) {
		if (
			attestation.data.runAttempt === undefined ||
			attestation.data.runAttempt !== runAttempt
		) {
			return [
				{
					file: BUNDLE_ATTESTATION,
					message:
						"bundle attestation runAttempt does not match this workflow attempt; rebuild with pnpm run agent-plugin:build in this job",
				},
			];
		}
	}
	const sha256 = createHash("sha256")
		.update(readFileSync(bundlePath))
		.digest("hex");
	if (attestation.data.sha256 !== sha256) {
		return [
			{
				file: BUNDLE_ATTESTATION,
				message:
					"sha256 does not match bin/hobo-mcp.mjs; rebuild with pnpm run agent-plugin:build in this CI job",
			},
		];
	}
	return [];
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

function trustedGithubHeadSha(
	repoRoot: string,
	raw: string | undefined,
): string | undefined {
	const headSha = raw?.trim();
	if (headSha === undefined || headSha.length === 0) return undefined;
	if (!/^[0-9a-f]{40,64}$/iu.test(headSha)) return undefined;
	const verified = spawnSync("git", ["cat-file", "-e", `${headSha}^{commit}`], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (verified.status !== 0) return undefined;
	return headSha.toLowerCase();
}

export function versionPinCommitIsh(repoRoot: string): string {
	const eventName = process.env.GITHUB_EVENT_NAME?.trim();
	let mergePrHead: string | undefined;
	if (eventName === "pull_request" || eventName === "merge_group") {
		const prHead = spawnSync("git", ["rev-parse", "HEAD^2"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		const sha = prHead.stdout?.trim().toLowerCase() ?? "";
		if (prHead.status === 0 && sha.length > 0) mergePrHead = sha;
	}
	const envSha = trustedGithubHeadSha(repoRoot, process.env.GITHUB_HEAD_SHA);
	if (mergePrHead !== undefined) {
		if (envSha !== undefined && envSha === mergePrHead) return envSha;
		return mergePrHead;
	}
	if (envSha !== undefined) return envSha;
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
			!agentPluginCiActive();
		if (!allowLocalSkip) throw error;
		return undefined;
	}
}

function ensureCiPluginBundle(repoRoot: string): void {
	if (!agentPluginCiActive()) return;
	const bundle = path.join(repoRoot, "plugins/hobo/bin/hobo-mcp.mjs");
	if (existsSync(bundle)) return;
	const build = spawnSync("pnpm", ["run", "agent-plugin:build"], {
		cwd: repoRoot,
		stdio: "inherit",
		env: process.env,
	});
	if (build.status !== 0) process.exit(build.status ?? 1);
}

function main(): void {
	const repoRoot = path.resolve(import.meta.dirname, "..");
	ensureCiPluginBundle(repoRoot);
	const versionFromReleaseTrain = releaseTrainVersionForPluginGate(repoRoot);
	if (versionFromReleaseTrain === undefined) {
		if (agentPluginCiActive()) {
			console.error(
				"agent-plugin:check: release-train version is required in CI; unset HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN",
			);
			process.exit(1);
		}
		console.warn(
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
