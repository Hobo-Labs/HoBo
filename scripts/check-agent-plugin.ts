import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
	checkHoboRepoSkillsConformance,
	HOBO_OWNED_ALLOWED_FIELDS,
	HOBO_PORTABLE_PLUGIN_SYNCED_SKILLS,
} from "@hobo/agent-skills";
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
const FORBIDDEN_ENV_KEYS: readonly string[] = [
	"PLUGIN_ROOT",
	"PLUGIN_DATA",
	"NODE_OPTIONS",
	"NODE_PRELOAD",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"NODE_EXTRA_CA_CERTS",
	"NODE_PATH",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"ELECTRON_RUN_AS_NODE",
	"NODE_COMPILE_CACHE",
	"NODE_V8_COVERAGE",
	"PATH",
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_SSL_CAINFO",
	"CURL_CA_BUNDLE",
	"npm_config_cafile",
	"npm_config_userconfig",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"RUBYOPT",
	"PERL5OPT",
];
const MCP_ENTRYPOINT = "${PLUGIN_ROOT}/bin/hobo-mcp.mjs";
const BUNDLE_ATTESTATION = ".bundle-attestation.json";
const NON_PUBLISHING_MARKER = ".agent-plugin-nonpublishing.json";
const NonPublishingMarkerSchema = z.strictObject({
	publishable: z.literal(false),
	reason: z.enum(["pull_request", "merge_group"]),
	runId: z.string().min(1),
	runAttempt: z.string().min(1),
	commitSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu),
	digest: z.string().regex(/^[0-9a-f]{64}$/u),
});
const SECRET_KEY_PATTERN =
	/(?:token|secret|password|passwd|credential|api[-_]?key|private[-_]?key)/iu;
export const SECRET_VALUE_PATTERN =
	/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{16,}|sk-or-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|npm_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/u;

export const PLUGIN_ALLOWED_SKILL_FIELDS = HOBO_OWNED_ALLOWED_FIELDS;
export const SYNCED_SKILLS = HOBO_PORTABLE_PLUGIN_SYNCED_SKILLS;

const CI_ACTIVITY_ENV_NAMES: readonly string[] = [
	"CI",
	"GITHUB_ACTIONS",
	"TF_BUILD",
	"BUILD_ID",
	"TEAMCITY_VERSION",
	"GITLAB_CI",
	"CIRCLECI",
	"BUILDKITE",
	"CODEBUILD_BUILD_ID",
	"GITHUB_EVENT_NAME",
	"GITHUB_RUN_ID",
	"GITHUB_REPOSITORY",
	"GITHUB_SHA",
];

export function agentPluginCiActive(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return CI_ACTIVITY_ENV_NAMES.some((name) => {
		const set = (env[name] ?? "").trim().toLowerCase();
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

type AgentPluginAttestationExpectation = {
	readonly bundlePath: string;
	readonly runId: string;
	readonly runAttempt: string;
	readonly commitSha: string;
};

type VerifyAgentPluginAttestation = (
	expected: AgentPluginAttestationExpectation,
) => Promise<void>;

const VerifiedArtifactAttestations = z.array(
	z.object({
		verificationResult: z.object({
			signature: z.object({
				certificate: z.object({
					extensions: z.object({
						buildSignerDigest: z.string().optional(),
						buildSignerURI: z.string().optional(),
						runInvocationURI: z.string().optional(),
					}),
				}),
			}),
		}),
	}),
);

type AttestationCommandResult = {
	readonly error?: Error | undefined;
	readonly status: number | null;
	readonly stdout: string;
};

type AttestationCommand = (
	command: string,
	args: readonly string[],
) => AttestationCommandResult;

const runAttestationCommand: AttestationCommand = (command, args) => {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return {
		error: result.error,
		status: result.status,
		stdout: result.stdout,
	};
};

export async function verifyAgentPluginAttestation(
	expected: AgentPluginAttestationExpectation,
	run: AttestationCommand = runAttestationCommand,
): Promise<void> {
	const serverUrl = process.env.GITHUB_SERVER_URL?.trim() ?? "";
	const repository = process.env.GITHUB_REPOSITORY?.trim() ?? "";
	if (serverUrl.length === 0 || repository.toLowerCase() !== "hobo-labs/hobo") {
		throw new Error("GitHub repository identity is unavailable");
	}
	const signerWorkflow = `${repository}/.github/workflows/hobo-ci.yml`;
	const normalizedServerUrl = serverUrl.replace(/\/$/u, "");
	const signerUri = `${normalizedServerUrl}/${signerWorkflow}@refs/heads/main`;
	const verified = run("gh", [
		"attestation",
		"verify",
		expected.bundlePath,
		"--repo",
		repository,
		"--signer-workflow",
		signerWorkflow,
		"--cert-identity",
		signerUri,
		"--cert-oidc-issuer",
		"https://token.actions.githubusercontent.com",
		"--source-digest",
		expected.commitSha,
		"--format",
		"json",
	]);
	if (verified.error !== undefined || verified.status !== 0) {
		throw new Error("GitHub artifact attestation verification failed");
	}
	const attestations = VerifiedArtifactAttestations.parse(
		JSON.parse(verified.stdout),
	);
	const invocationId = `${normalizedServerUrl}/${repository}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`;
	const fromCurrentRun = (
		attestation: z.infer<typeof VerifiedArtifactAttestations>[number],
	) => {
		const extensions =
			attestation.verificationResult.signature.certificate.extensions;
		return extensions.runInvocationURI === invocationId;
	};
	if (
		!attestations.some((attestation) => {
			const extensions =
				attestation.verificationResult.signature.certificate.extensions;
			return (
				fromCurrentRun(attestation) &&
				extensions.buildSignerURI === signerUri &&
				extensions.buildSignerDigest === expected.commitSha
			);
		})
	) {
		if (attestations.some(fromCurrentRun)) {
			throw new Error(
				"attestation is not from hobo-ci.yml on refs/heads/main at the checked commit",
			);
		}
		throw new Error("attestation is not from this workflow run attempt");
	}
}

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

export const McpHttpServerSchema = z.strictObject({
	type: z.union([z.literal("streamable-http"), z.literal("sse")]),
	url: z.string().min(1),
	headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerSchema = z.discriminatedUnion("type", [
	McpStdioServerSchema,
	McpHttpServerSchema,
]);

export const McpConfigSchema = z.strictObject({
	$schema: z.string(),
	mcpServers: z.record(z.string(), McpServerSchema),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

const GithubEventPayloadSchema = z.object({
	pull_request: z.object({
		head: z.object({
			sha: z.string(),
		}),
	}),
});

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
	} catch {
		return {
			value: undefined,
			issues: [{ file, message: "cannot be parsed as JSON" }],
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
			if (comparison !== 0) {
				issues.push({
					file: "plugin.json",
					message: `version ${manifest.version} does not exactly match the release train ${versionFromReleaseTrain} for the checked commit; update it (scripts/ci/compute-release-version.mts)`,
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
	if (hobo.type !== "stdio") {
		issues.push({
			file: "mcp.json",
			message: "hobo MCP server command must be exactly node",
		});
		return issues;
	}
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

export function checkExecutableToken(
	where: string,
	command: string,
): AgentPluginIssue[] {
	const issues: AgentPluginIssue[] = [];
	const rooted = command.replace(/\$\{PLUGIN_(?:ROOT|DATA)\}/gu, "<root>");
	if (/\$\{[^}]+\}/u.test(rooted)) {
		issues.push({
			file: where,
			message: "executable must not contain environment expansion",
		});
	}
	if (rooted.split(/[\\/]/u).includes("..")) {
		issues.push({
			file: where,
			message: "executable must not traverse outside the plugin root",
		});
	}
	if (
		path.isAbsolute(command) ||
		path.win32.isAbsolute(command) ||
		/^[A-Za-z]:/u.test(command) ||
		/^~(?:[\\/]|$)/u.test(command) ||
		!/^[A-Za-z0-9._-]+(?:\/(?:[A-Za-z0-9._-]+|<root>))*$/u.test(rooted)
	) {
		issues.push({
			file: where,
			message:
				"executable must be a PATH command or a plugin-rooted relative path",
		});
	}
	return issues;
}

export function checkMcpEndpointUrl(
	where: string,
	value: string,
): AgentPluginIssue[] {
	const issue = (message: string): AgentPluginIssue[] => [
		{ file: where, message },
	];
	if (/\$\{|[\\\s]|%(?:2e|2f|5c)/iu.test(value) || value.includes("..")) {
		return issue("MCP endpoint URL must not contain expansion or traversal");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return issue("MCP endpoint URL must be an absolute URL");
	}
	if (url.protocol !== "https:") {
		return issue("MCP endpoint URL must use https");
	}
	if (url.username !== "" || url.password !== "") {
		return issue("MCP endpoint URL must not embed credentials");
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	if (net.isIP(hostname) !== 0) {
		return issue("MCP endpoint URL must use a public DNS hostname, not an IP");
	}
	if (
		!hostname.includes(".") ||
		/(?:^|\.)(?:localhost|local|internal|test|invalid|home\.arpa)$/u.test(
			hostname,
		) ||
		hostname === "metadata.google.internal" ||
		hostname === "instance-data"
	) {
		return issue("MCP endpoint URL must use a public DNS hostname");
	}
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname)) {
		return issue("MCP endpoint URL has an invalid hostname");
	}
	return [];
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
		if (server.type === "stdio") {
			issues.push(...checkExecutableToken(where, server.command));
			for (const arg of server.args ?? []) {
				issues.push(...checkPluginScopedPath(where, arg));
			}
			if (server.cwd !== undefined) {
				issues.push(...checkPluginScopedPath(where, server.cwd));
			}
			for (const [key, value] of Object.entries(server.env ?? {})) {
				if (/\$\{[^}]+\}/u.test(value)) {
					issues.push({
						file: where,
						message: `env value for "${key}" must not contain environment expansion`,
					});
				}
				issues.push(...scanTextForSecrets(`${where} env.${key}`, value));
				if (
					FORBIDDEN_ENV_KEYS.some(
						(forbidden) =>
							forbidden.localeCompare(key, undefined, {
								sensitivity: "accent",
							}) === 0,
					)
				) {
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
			continue;
		}
		issues.push(...checkMcpEndpointUrl(where, server.url));
		for (const [key, value] of Object.entries(server.headers ?? {})) {
			if (/\$\{[^}]+\}/u.test(value)) {
				issues.push({
					file: where,
					message: `header value for "${key}" must not contain environment expansion`,
				});
			}
			issues.push(...scanTextForSecrets(`${where} headers.${key}`, value));
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
	if (/\$\{[^}]+\}/u.test(rooted)) {
		issues.push({
			file: where,
			message:
				"plugin-scoped path may only use ${PLUGIN_ROOT} or ${PLUGIN_DATA} expansion",
		});
	}
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
	if (/^[A-Za-z]:[^\\/]/u.test(value)) {
		issues.push({
			file: where,
			message:
				"plugin-scoped path must not use a Windows drive-relative form (for example C:foo)",
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
				message: `relative link "${redactDiagnosticText(target)}" resolves outside the plugin root`,
			});
		} else if (!existsSync(resolved)) {
			issues.push({
				file: relativeFile,
				message: `relative link "${redactDiagnosticText(target)}" has no local target in the plugin`,
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
	const lines = text.split("\n");
	if (!lines[0]?.startsWith("Source:")) return text;
	let index = 1;
	while (index < lines.length && lines[index]?.trim() === "") index++;
	return lines.slice(index).join("\n").trimStart();
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

function redactDiagnosticText(text: string): string {
	const pattern = new RegExp(
		SECRET_VALUE_PATTERN.source,
		`${SECRET_VALUE_PATTERN.flags}g`,
	);
	return text.replace(pattern, "[redacted]");
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
		return redactDiagnosticText(
			text.slice(start, start + 50) || "(end of text)",
		);
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
	const pluginFiles = new Set(listFilesRecursive(pluginSkillDir, { issues }));
	const repoFiles = new Set(listFilesRecursive(repoSkillDir, { issues }));
	for (const relative of repoFiles) {
		if (pluginFiles.has(relative)) continue;
		issues.push({
			file: path.join("skills", skill, relative),
			message: `is missing from the plugin but exists in .agents/skills/${skill}; copy the repo file`,
		});
	}
	for (const relative of pluginFiles) {
		if (repoFiles.has(relative)) continue;
		issues.push({
			file: path.join("skills", skill, relative),
			message: `is shipped in the plugin but has no mirrored .agents/skills/${skill} source; add it to the repo skill or remove it here`,
		});
	}
	for (const relative of pluginFiles) {
		if (relative === "SKILL.md" || !repoFiles.has(relative)) continue;
		const relativeFile = path.join("skills", skill, relative);
		const repoFile = path.join(repoSkillDir, relative);
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
		if (relative.endsWith(".md")) {
			issues.push(...checkMarkdownLinks(pluginRoot, relativeFile));
		}
	}
	return issues;
}

function listFilesRecursive(
	dir: string,
	options?: {
		readonly issues?: AgentPluginIssue[];
		readonly filePrefix?: string;
	},
): string[] {
	const issues = options?.issues;
	const filePrefix = options?.filePrefix ?? "";
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relativeName = filePrefix
			? path.join(filePrefix, entry.name)
			: entry.name;
		if (entry.isSymbolicLink()) {
			issues?.push({
				file: relativeName,
				message:
					"symbolic links are not allowed in the shipped plugin tree; replace with a regular file or directory",
			});
			continue;
		}
		if (entry.isDirectory()) {
			const nestedOptions =
				issues === undefined
					? { filePrefix: relativeName }
					: { issues, filePrefix: relativeName };
			for (const nested of listFilesRecursive(
				path.join(dir, entry.name),
				nestedOptions,
			)) {
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
		for (const [index, line] of readFileSync(manifestPath, "utf8")
			.split("\n")
			.entries()) {
			if (line === "") continue;
			const [, digest, name] = VENDORED_SCHEMA_MANIFEST.exec(line) ?? [];
			if (digest === undefined || name === undefined) {
				issues.push({
					file: "tools/agent-plugins/schemas/1.0.0/MANIFEST.sha256",
					message: `has an invalid entry at line ${index + 1}`,
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
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(full, "utf8"));
		} catch {
			issues.push({
				file,
				message: "is not valid JSON",
			});
			continue;
		}
		const schema = PluginVendoredSchema.safeParse(parsed);
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

export async function checkAgentPlugin(input: {
	pluginRoot: string;
	repoRoot: string;
	versionFromReleaseTrain?: string | undefined;
	verifyAttestation?: VerifyAgentPluginAttestation | undefined;
}): Promise<AgentPluginReport> {
	const { pluginRoot, repoRoot } = input;
	const issues: AgentPluginIssue[] = [];
	const notes: string[] = [];

	issues.push(...githubHeadShaMismatchIssues(repoRoot));
	issues.push(...pluginManifestStagedGitIssues(repoRoot));

	if (input.versionFromReleaseTrain === undefined && agentPluginCiActive()) {
		issues.push({
			file: "plugin.json",
			message:
				"release-train version could not be computed in CI; fix version.json/nbgv or unset HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN",
		});
	}
	if (input.versionFromReleaseTrain === undefined && !agentPluginCiActive()) {
		notes.push(
			"agent-plugin:check: skipped release-train comparison outside CI (set CI plus GitHub/Azure flags or unset HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN to measure the train locally)",
		);
	}
	const manifestText = readPluginManifestForCheck(pluginRoot, repoRoot, issues);
	if (manifestText !== undefined) {
		const manifest = parsePluginManifest(manifestText);
		issues.push(...manifest.issues);
		if (manifest.value !== undefined) {
			issues.push(
				...manifestSemanticIssues(
					manifest.value,
					input.versionFromReleaseTrain,
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
		listFilesRecursive(pluginRoot, { issues });
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
		if (!agentPluginCiActive()) {
			notes.push(
				"agent-plugin:check: explicit local-only non-CI path; the freshly rebuilt bundle has no provenance and cannot be reused for CI validation",
			);
		} else if (
			process.env.GITHUB_EVENT_NAME === "pull_request" ||
			process.env.GITHUB_EVENT_NAME === "merge_group"
		) {
			notes.push(
				"agent-plugin:check: non-publishing PR validation rebuilt and checked the current bundle without provenance or GitHub credentials",
			);
		}
		issues.push(
			...(await bundleAttestationIssues(
				pluginRoot,
				bundle,
				input.verifyAttestation ?? verifyAgentPluginAttestation,
			)),
		);
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
		} else {
			for (const relative of listFilesRecursive(deployFixtures, {
				issues: issues,
				filePrefix: "fixtures/deploy",
			})) {
				const relativeFile = path.join("fixtures/deploy", relative);
				issues.push(
					...scanTextForSecrets(
						relativeFile,
						readFileSync(path.join(deployFixtures, relative), "utf8"),
					),
				);
			}
		}
		const pluginSrc = path.join(pluginRoot, "src");
		if (existsSync(pluginSrc)) {
			for (const relative of listFilesRecursive(pluginSrc, {
				issues: issues,
				filePrefix: "src",
			})) {
				const relativeFile = path.join("src", relative);
				issues.push(
					...scanTextForSecrets(
						relativeFile,
						readFileSync(path.join(pluginSrc, relative), "utf8"),
					),
				);
			}
		}
	} else {
		issues.push({
			file: "bin/hobo-mcp.mjs",
			message:
				"is missing; build it with pnpm run agent-plugin:build before agent-plugin:check",
		});
	}
	return { issues, notes };
}

async function bundleAttestationIssues(
	pluginRoot: string,
	bundlePath: string,
	verifyAttestation: VerifyAgentPluginAttestation,
): Promise<AgentPluginIssue[]> {
	const failure = (message: string, file = "bin/hobo-mcp.mjs") => [
		{ file, message },
	];
	if (!agentPluginCiActive()) return [];
	if (process.env.GITHUB_ACTIONS !== "true") {
		return failure(
			"bundle attestation is only verified in GitHub Actions (GITHUB_ACTIONS=true); non-GitHub CI cannot accept a bundle",
		);
	}
	if (existsSync(path.join(pluginRoot, BUNDLE_ATTESTATION))) {
		return failure(
			"is a legacy bearer-token record, not GitHub artifact provenance; remove it and run the isolated attestation job",
			BUNDLE_ATTESTATION,
		);
	}
	const eventName = process.env.GITHUB_EVENT_NAME?.trim();
	const nonPublishing =
		eventName === "pull_request" || eventName === "merge_group";
	const markerPath = path.join(pluginRoot, NON_PUBLISHING_MARKER);
	if (!nonPublishing) {
		if (existsSync(markerPath)) {
			return failure(
				"is an untrusted non-publishing PR bundle; rebuild in the trusted agent-plugin-provenance job before verification",
				NON_PUBLISHING_MARKER,
			);
		}
	} else {
		if (!existsSync(markerPath)) {
			return failure(
				"non-publishing PR validation requires a bundle marker from the current build",
				NON_PUBLISHING_MARKER,
			);
		}
		let parsed: ReturnType<typeof NonPublishingMarkerSchema.safeParse>;
		try {
			parsed = NonPublishingMarkerSchema.safeParse(
				JSON.parse(readFileSync(markerPath, "utf8")),
			);
		} catch {
			return failure(
				"is not a valid non-publishing bundle marker; rebuild in the current PR job",
				NON_PUBLISHING_MARKER,
			);
		}
		if (!parsed.success) {
			return failure(
				"is not a valid non-publishing bundle marker; rebuild in the current PR job",
				NON_PUBLISHING_MARKER,
			);
		}
		const digest = createHash("sha256")
			.update(readFileSync(bundlePath))
			.digest("hex");
		if (
			parsed.data.reason !== eventName ||
			parsed.data.runId !== process.env.GITHUB_RUN_ID?.trim() ||
			parsed.data.runAttempt !== process.env.GITHUB_RUN_ATTEMPT?.trim() ||
			parsed.data.commitSha.toLowerCase() !==
				process.env.GITHUB_SHA?.trim().toLowerCase() ||
			parsed.data.digest !== digest
		) {
			return failure(
				"does not bind this bundle to the current event, commit, run, attempt, and digest; rebuild in the current PR job",
				NON_PUBLISHING_MARKER,
			);
		}
		return [];
	}
	if ((process.env.GITHUB_TOKEN ?? "").trim().length === 0) {
		return failure(
			"attestation verification requires GITHUB_TOKEN with attestations:read; refusing to downgrade to an unverified bundle",
		);
	}
	const runId = process.env.GITHUB_RUN_ID?.trim();
	if (runId === undefined || runId.length === 0) {
		return failure(
			"bundle attestation is only trusted in a GitHub Actions job with GITHUB_RUN_ID; rebuild in CI before agent-plugin:check",
		);
	}
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim();
	if (runAttempt === undefined || runAttempt.length === 0) {
		return failure(
			"bundle attestation is only trusted in a GitHub Actions job with GITHUB_RUN_ATTEMPT; rebuild in CI before agent-plugin:check",
		);
	}
	const commitSha = process.env.GITHUB_SHA?.trim();
	if (commitSha === undefined || commitSha.length === 0) {
		return failure(
			"bundle attestation is only trusted in a GitHub Actions job with GITHUB_SHA; rebuild in CI before agent-plugin:check",
		);
	}
	try {
		await verifyAttestation({ bundlePath, runId, runAttempt, commitSha });
	} catch {
		return failure(
			"has no verified GitHub artifact provenance binding its digest to this repository, workflow, commit, run, and attempt; run the isolated agent-plugin-provenance job",
		);
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

function readPluginManifestForCheck(
	pluginRoot: string,
	repoRoot: string,
	issues: AgentPluginIssue[],
): string | undefined {
	const staged = stagedPluginManifestGitResult(repoRoot);
	if (!staged.ok) {
		issues.push(staged.issue);
		return undefined;
	}
	if (!staged.staged) return readPluginFile(pluginRoot, "plugin.json", issues);
	const result = spawnSync("git", ["show", ":plugins/hobo/plugin.json"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (result.error !== undefined || result.status !== 0) {
		issues.push({
			file: "plugin.json",
			message:
				"git could not read the staged plugin.json blob; refuse version measurement",
		});
		return undefined;
	}
	return result.stdout;
}

function stagedPluginManifestGitResult(repoRoot: string):
	| {
			readonly ok: true;
			readonly staged: boolean;
	  }
	| {
			readonly ok: false;
			readonly issue: AgentPluginIssue;
	  } {
	const result = spawnSync(
		"git",
		["diff", "--cached", "--name-only", "--", "plugins/hobo/plugin.json"],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	if (result.error !== undefined) {
		return {
			ok: false,
			issue: {
				file: "plugin.json",
				message:
					"git is unavailable for staged plugin.json inspection; refuse version measurement",
			},
		};
	}
	if (result.status !== 0) {
		return {
			ok: false,
			issue: {
				file: "plugin.json",
				message:
					"git could not list staged plugin.json changes; refuse version measurement",
			},
		};
	}
	return {
		ok: true,
		staged: (result.stdout ?? "").trim().length > 0,
	};
}

function pluginManifestStagedGitIssues(
	repoRoot: string,
): readonly AgentPluginIssue[] {
	const staged = stagedPluginManifestGitResult(repoRoot);
	return staged.ok ? [] : [staged.issue];
}

function pluginManifestStaged(repoRoot: string): boolean {
	const staged = stagedPluginManifestGitResult(repoRoot);
	if (!staged.ok) {
		throw new Error(staged.issue.message);
	}
	return staged.staged;
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

function gitResolvedCommit(
	repoRoot: string,
	revision: string,
): string | undefined {
	const result = spawnSync(
		"git",
		["rev-parse", "--verify", `${revision}^{commit}`],
		{
			cwd: repoRoot,
			encoding: "utf8",
		},
	);
	const sha = result.stdout?.trim().toLowerCase() ?? "";
	if (result.status !== 0 || !/^[0-9a-f]{40,64}$/iu.test(sha)) return undefined;
	return sha;
}

function githubEventHeadSha(): string | undefined {
	const eventName = process.env.GITHUB_EVENT_NAME?.trim();
	if (eventName !== "pull_request") return undefined;
	const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
	if (
		eventPath === undefined ||
		eventPath.length === 0 ||
		!existsSync(eventPath)
	) {
		return undefined;
	}
	try {
		const payload = GithubEventPayloadSchema.safeParse(
			JSON.parse(readFileSync(eventPath, "utf8")),
		);
		return payload.success ? payload.data.pull_request.head.sha : undefined;
	} catch {
		return undefined;
	}
}

type PrBranchTipSources = {
	readonly explicit: string | undefined;
	readonly explicitRaw: string | undefined;
	readonly headSecondParent: string | undefined;
	readonly githubSecondParent: string | undefined;
	readonly eventPayload: string | undefined;
	readonly eventRaw: string | undefined;
};

function prBranchTipSources(repoRoot: string): PrBranchTipSources {
	const eventRaw = githubEventHeadSha();
	const githubSha = process.env.GITHUB_SHA?.trim();
	return {
		explicit: trustedGithubHeadSha(repoRoot, process.env.GITHUB_HEAD_SHA),
		explicitRaw: process.env.GITHUB_HEAD_SHA?.trim(),
		headSecondParent: gitResolvedCommit(repoRoot, "HEAD^2"),
		githubSecondParent:
			githubSha === undefined || githubSha.length === 0
				? undefined
				: gitResolvedCommit(repoRoot, `${githubSha}^2`),
		eventPayload: trustedGithubHeadSha(repoRoot, eventRaw),
		eventRaw,
	};
}

function resolvedPrBranchTip(sources: PrBranchTipSources): string | undefined {
	return (
		sources.headSecondParent ??
		sources.githubSecondParent ??
		sources.eventPayload ??
		sources.explicit
	);
}

export function githubHeadShaMismatchIssues(
	repoRoot: string,
): readonly AgentPluginIssue[] {
	const eventName = process.env.GITHUB_EVENT_NAME?.trim();
	if (eventName !== "pull_request" && eventName !== "merge_group") return [];
	const sources = prBranchTipSources(repoRoot);
	const issue = (message: string): AgentPluginIssue[] => [
		{ file: "plugin.json", message },
	];
	if (sources.explicitRaw !== undefined && sources.explicitRaw.length > 0) {
		if (sources.explicit === undefined) {
			return issue(
				"GITHUB_HEAD_SHA is set but is not a verifiable commit in this checkout; refuse version measurement",
			);
		}
		if (
			sources.headSecondParent !== undefined &&
			sources.explicit !== sources.headSecondParent
		) {
			return issue(
				"GITHUB_HEAD_SHA does not match the PR branch tip (HEAD^2); refuse version measurement on this checkout topology",
			);
		}
	}
	if (sources.eventRaw !== undefined && sources.eventPayload === undefined) {
		return issue(
			"the GitHub event payload's pull request head SHA is not a verifiable commit in this checkout; refuse version measurement",
		);
	}
	const candidates = [
		sources.headSecondParent,
		sources.githubSecondParent,
		sources.eventPayload,
		sources.explicit,
	].filter((sha): sha is string => sha !== undefined);
	const tip = resolvedPrBranchTip(sources);
	if (tip === undefined || candidates.length === 0) {
		return issue(
			"cannot resolve the PR branch tip from HEAD^2, GITHUB_SHA^2, the event payload, or GITHUB_HEAD_SHA; refuse version measurement",
		);
	}
	if (candidates.some((sha) => sha !== tip)) {
		return issue(
			"PR branch tip sources disagree; refuse version measurement on this checkout topology",
		);
	}
	return [];
}

export function versionPinCommitIsh(repoRoot: string): string {
	const eventName = process.env.GITHUB_EVENT_NAME?.trim();
	if (eventName !== "pull_request" && eventName !== "merge_group")
		return "HEAD";
	return resolvedPrBranchTip(prBranchTipSources(repoRoot)) ?? "HEAD";
}

export function releaseTrainSemverForPluginCheck(
	repoRoot: string,
	nbgv: NbgvRunner = defaultNbgvRunner(repoRoot),
): string {
	const config = loadVersionJsonHeightConfig(repoRoot);
	const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (shallow.status !== 0 || shallow.stdout?.trim() === "true") {
		throw new Error(
			"release-train version requires full git history or a pinned base; shallow checkout refused",
		);
	}
	if (githubHeadShaMismatchIssues(repoRoot).length > 0) {
		throw new Error(
			"cannot verify the pull request branch tip for release-train version measurement",
		);
	}
	const commitIsh = versionPinCommitIsh(repoRoot);
	if (pluginManifestStagedGitIssues(repoRoot).length > 0) {
		throw new Error(
			`cannot inspect staged plugin.json for release-train bump at ${commitIsh}`,
		);
	}
	const rawHeight = nbgv("VersionHeight", commitIsh).trim();
	if (rawHeight.length === 0) {
		throw new Error(`empty VersionHeight output at ${commitIsh}`);
	}
	const height = Number(rawHeight);
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
	if (
		agentPluginCiActive() &&
		process.env.HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN === "1"
	) {
		throw new Error(
			"HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN is not allowed in CI",
		);
	}
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

function agentPluginCheckPreflight(): void {
	const verifyRequested = process.argv.includes("--verify-attestation");
	const mainCi =
		process.env.GITHUB_ACTIONS === "true" &&
		process.env.GITHUB_REF === "refs/heads/main" &&
		["push", "schedule", "workflow_dispatch"].includes(
			process.env.GITHUB_EVENT_NAME?.trim() ?? "",
		);
	if (mainCi && !verifyRequested) {
		console.error(
			"agent-plugin:check: main CI requires --verify-attestation; a bundle without verified provenance cannot be accepted",
		);
		process.exit(1);
	}
	if (
		!agentPluginCiActive() &&
		process.env.HOBO_AGENT_PLUGIN_LOCAL_CHECK !== "1"
	) {
		console.error(
			"agent-plugin:check: set HOBO_AGENT_PLUGIN_LOCAL_CHECK=1 to check an existing bundle locally; CI checks require a recognized CI environment",
		);
		process.exit(1);
	}
}

async function main(): Promise<void> {
	const repoRoot = path.resolve(import.meta.dirname, "..");
	agentPluginCheckPreflight();
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
	const baseReport = await checkAgentPlugin({
		pluginRoot: path.join(repoRoot, "plugins/hobo"),
		repoRoot,
		versionFromReleaseTrain,
		verifyAttestation: verifyAgentPluginAttestation,
	});
	const conformance = await checkHoboRepoSkillsConformance(repoRoot);
	const conformanceIssues: AgentPluginIssue[] = conformance.map((issue) => ({
		file: `.agents/skills/${issue.skill}`,
		message: `${issue.code}: ${issue.message}`,
	}));
	const report: AgentPluginReport = {
		issues: [...baseReport.issues, ...conformanceIssues],
		notes: baseReport.notes,
	};
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
if (invokedDirectly) {
	void main();
}
