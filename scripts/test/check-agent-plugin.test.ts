import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAgentPlugin } from "../build-agent-plugin.mts";
import {
	AGENT_TOOLING_HEADING,
	agentToolingReferenceDriftIssues,
	bodyAfterFrontmatter,
	checkAgentPlugin,
	checkExecutableToken,
	checkMarkdownLinks,
	checkMcpEndpointUrl,
	checkPluginScopedPath,
	compareSemverPrecedence,
	githubHeadShaMismatchIssues,
	hoboMcpServerIssues,
	manifestSemanticIssues,
	mcpSemanticIssues,
	parseFrontmatterBlock,
	parseMcpConfig,
	parsePluginManifest,
	releaseTrainSemverForPluginCheck,
	releaseTrainVersionForPluginGate,
	scanTextForSecrets,
	verifyAgentPluginAttestation,
	versionPinCommitIsh,
} from "../check-agent-plugin.ts";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const realPluginRoot = path.join(repoRoot, "plugins/hobo");

const scratches: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	while (scratches.length > 0) {
		const dir = scratches.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function buildRealPluginForCheck(): Promise<string> {
	const scratch = await mkdtemp(path.join(tmpdir(), "hobo-real-plugin-"));
	scratches.push(scratch);
	const pluginRoot = path.join(scratch, "plugin");
	const excluded = new Set([
		"bin",
		"fixtures/deploy",
		"node_modules",
		".agent-plugin-build.lock",
		".agent-plugin-nonpublishing.json",
		".bundle-attestation.json",
	]);
	await cp(realPluginRoot, pluginRoot, {
		recursive: true,
		filter: (source) => {
			const relative = path
				.relative(realPluginRoot, source)
				.replaceAll("\\", "/");
			return ![...excluded].some(
				(name) => relative === name || relative.startsWith(`${name}/`),
			);
		},
	});
	stubCiOff();
	vi.stubEnv("HOBO_AGENT_PLUGIN_LOCAL_BUILD", "1");
	const previousExitCode = process.exitCode;
	process.exitCode = undefined;
	let buildExitCode: typeof process.exitCode;
	try {
		await buildAgentPlugin(pluginRoot);
		buildExitCode = process.exitCode;
	} finally {
		process.exitCode = previousExitCode;
	}
	expect(buildExitCode).toBeUndefined();
	expect(existsSync(path.join(pluginRoot, "bin/hobo-mcp.mjs"))).toBe(true);
	return pluginRoot;
}

function git(root: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
		);
	}
	return (result.stdout ?? "").trim();
}

async function scratchMergeRepo(): Promise<{
	repoRoot: string;
	prHead: string;
}> {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-agent-plugin-git-"));
	scratches.push(root);
	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	git(root, "config", "commit.gpgsign", "false");
	await writeFile(
		path.join(root, "version.json"),
		JSON.stringify({
			version: "0.0.0-alpha.{height}",
			versionHeightOffset: 3,
		}),
	);
	git(root, "add", "version.json");
	git(root, "commit", "-q", "-m", "base");
	const baseBranch = git(root, "symbolic-ref", "--short", "HEAD");
	git(root, "checkout", "-q", "-b", "pr");
	await writeFile(path.join(root, "pr.txt"), "pr head\n");
	git(root, "add", "pr.txt");
	git(root, "commit", "-q", "-m", "pr head");
	const prHead = git(root, "rev-parse", "HEAD");
	git(root, "checkout", "-q", baseBranch);
	git(root, "merge", "--no-ff", "-q", "-m", "merge pr", "pr");
	expect(git(root, "rev-parse", "--verify", "HEAD^2")).toBe(prHead);
	return { repoRoot: root, prHead };
}

function stubCiEnvironment(event: string, headSha = "") {
	vi.stubEnv("GITHUB_EVENT_NAME", event);
	vi.stubEnv("GITHUB_HEAD_SHA", headSha);
	vi.stubEnv("GITHUB_EVENT_PATH", undefined);
}

function stubCiOff() {
	for (const variable of [
		"CI",
		"GITHUB_ACTIONS",
		"TF_BUILD",
		"BUILD_ID",
		"TEAMCITY_VERSION",
		"GITLAB_CI",
		"CIRCLECI",
		"BUILDKITE",
		"CODEBUILD_BUILD_ID",
	] as const) {
		vi.stubEnv(variable, undefined);
	}
	vi.stubEnv("GITHUB_RUN_ID", undefined);
	vi.stubEnv("GITHUB_SHA", undefined);
	vi.stubEnv("GITHUB_RUN_ATTEMPT", undefined);
	vi.stubEnv("GITHUB_EVENT_NAME", undefined);
	vi.stubEnv("GITHUB_HEAD_SHA", undefined);
	vi.stubEnv("GITHUB_EVENT_PATH", undefined);
	vi.stubEnv("GITHUB_REPOSITORY", undefined);
	vi.stubEnv("GITHUB_SERVER_URL", undefined);
	vi.stubEnv("GH_TOKEN", undefined);
}

function recordingNbgv(height: string) {
	const calls: Array<{ variable: string; commitIsh: string }> = [];
	return {
		calls,
		nbgv: (variable: string, commitIsh?: string) => {
			calls.push({ variable, commitIsh: commitIsh ?? "HEAD" });
			return height;
		},
	};
}

async function scratchPlugin(
	files: Record<string, string>,
): Promise<{ pluginRoot: string; repoRoot: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-agent-plugin-"));
	scratches.push(root);
	const pluginRoot = path.join(root, "plugin");
	const scratchRepoRoot = path.join(root, "repo");
	for (const [name, content] of Object.entries(files)) {
		const target = name.startsWith("repo:")
			? path.join(scratchRepoRoot, name.slice(5))
			: path.join(pluginRoot, name);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content);
	}
	const schemaDir = path.join(
		scratchRepoRoot,
		"tools/agent-plugins/schemas/1.0.0",
	);
	await mkdir(schemaDir, { recursive: true });
	for (const schema of ["plugin.schema.json", "mcp.schema.json"]) {
		await writeFile(
			path.join(schemaDir, schema),
			await readFile(
				path.join(repoRoot, "tools/agent-plugins/schemas/1.0.0", schema),
				"utf8",
			),
		);
	}
	await writeFile(
		path.join(schemaDir, "MANIFEST.sha256"),
		await readFile(
			path.join(repoRoot, "tools/agent-plugins/schemas/1.0.0/MANIFEST.sha256"),
			"utf8",
		),
	);
	return { pluginRoot, repoRoot: scratchRepoRoot };
}

const validManifest = {
	$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
	name: "hobo",
	version: "0.0.0-alpha.362",
	author: { name: "Hobo Labs", url: "https://github.com/Hobo-Labs" },
};

describe("parsePluginManifest + manifestSemanticIssues", () => {
	it("accepts the shipped manifest shape", () => {
		const parsed = parsePluginManifest(JSON.stringify(validManifest));
		expect(parsed.issues).toEqual([]);
		expect(parsed.value?.name).toBe("hobo");
		expect(
			manifestSemanticIssues(parsed.value ?? validManifest, "0.0.0-alpha.362"),
		).toEqual([]);
	});

	it("does not echo malformed JSON input in parse diagnostics", () => {
		const secret = "ghp_abcdefghijklmnopqrst";
		for (const parsed of [
			parsePluginManifest(`{"name": ${secret} invalid`),
			parseMcpConfig(`{"mcpServers": ${secret} invalid`),
		]) {
			expect(parsed.issues).toEqual([
				{
					file: expect.stringMatching(/^(?:plugin|mcp)\.json$/u),
					message: "cannot be parsed as JSON",
				},
			]);
			expect(JSON.stringify(parsed.issues)).not.toContain(secret);
		}
	});

	it("rejects unknown fields, wrong $schema, bad names, and non-semver versions", () => {
		const parsed = parsePluginManifest(
			JSON.stringify({
				...validManifest,
				$schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
				name: "HoBo!",
				version: "not-semver",
				surprise: true,
			}),
		);
		const messages = parsed.issues.map((issue) => issue.message).join("\n");
		expect(messages).toMatch(/field "surprise" is not allowed/u);
		expect(messages).toMatch(/name violates the 1\.0\.0 name grammar/u);
		expect(messages).toMatch(/version must be a semver string/u);
		expect(parsed.value).toBeUndefined();
		const semantic = manifestSemanticIssues({
			...validManifest,
			$schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
		});
		expect(semantic.map((issue) => issue.message).join("\n")).toMatch(
			/\$schema must be exactly/u,
		);
	});

	it("flags a valid semver that lags the release train", () => {
		const issues = manifestSemanticIssues(validManifest, "0.0.0-alpha.400");
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/does not exactly match/u);
	});

	it("flags a numeric-prerelease pin that is strictly older, not lexically older", () => {
		const issues = manifestSemanticIssues(
			{ ...validManifest, version: "0.0.0-alpha.9" },
			"0.0.0-alpha.400",
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/does not exactly match/u);
	});

	it("rejects higher fixed-alpha heights outside PR validation", () => {
		expect(
			manifestSemanticIssues(
				{ ...validManifest, version: "0.0.0-alpha.500" },
				"0.0.0-alpha.400",
			),
		).toHaveLength(1);
		for (const version of ["0.1.0", "0.0.1-alpha.500", "0.0.0-beta.500"]) {
			expect(
				manifestSemanticIssues(
					{ ...validManifest, version },
					"0.0.0-alpha.400",
				),
			).toHaveLength(1);
		}
	});

	it("rejects a one-height squash merge lag on push", () => {
		vi.stubEnv("GITHUB_EVENT_NAME", "push");
		for (const version of ["0.0.0-alpha.399", "0.0.0-alpha.398"]) {
			const issues = manifestSemanticIssues(
				{ ...validManifest, version },
				"0.0.0-alpha.400",
			);
			expect(issues).toHaveLength(1);
			expect(issues[0]?.message).toMatch(/does not exactly match/u);
		}
		vi.unstubAllEnvs();
	});

	it("rejects a newer height on every event path", () => {
		for (const eventName of [
			undefined,
			"push",
			"pull_request",
			"merge_group",
		]) {
			if (eventName === undefined) vi.stubEnv("GITHUB_EVENT_NAME", undefined);
			else vi.stubEnv("GITHUB_EVENT_NAME", eventName);
			const issues = manifestSemanticIssues(
				{ ...validManifest, version: "0.0.0-alpha.500" },
				"0.0.0-alpha.400",
			);
			expect(issues).toHaveLength(1);
			expect(issues[0]?.message).toMatch(/does not exactly match/u);
		}
		vi.unstubAllEnvs();
	});

	it("rejects a name with consecutive dots or dashes", () => {
		expect(
			parsePluginManifest(JSON.stringify({ ...validManifest, name: "ho..bo" }))
				.issues,
		).toHaveLength(1);
		expect(
			parsePluginManifest(JSON.stringify({ ...validManifest, name: "ho--bo" }))
				.issues,
		).toHaveLength(1);
		expect(
			parsePluginManifest(JSON.stringify({ ...validManifest, name: "hobo" }))
				.issues,
		).toEqual([]);
	});
});

describe("compareSemverPrecedence", () => {
	it("orders train-style prerelease heights numerically and ignores build metadata", () => {
		expect(compareSemverPrecedence("0.0.0-alpha.9", "0.0.0-alpha.400")).toBe(
			-1,
		);
		expect(
			compareSemverPrecedence("0.0.0-alpha.400", "0.0.0-alpha.400+build.1"),
		).toBe(0);
		expect(compareSemverPrecedence("0.0.0-alpha.401", "0.0.0-alpha.400")).toBe(
			1,
		);
	});

	it("follows semver precedence: release beats prerelease, numeric loses to alphanumeric, shorter prerelease is smaller", () => {
		expect(compareSemverPrecedence("0.0.0", "0.0.0-alpha.400")).toBe(1);
		expect(compareSemverPrecedence("0.0.0-alpha.2", "0.0.0-alpha.beta")).toBe(
			-1,
		);
		expect(compareSemverPrecedence("0.0.0-alpha", "0.0.0-alpha.1")).toBe(-1);
		expect(compareSemverPrecedence("0.0.1-alpha.400", "0.0.0-alpha.400")).toBe(
			1,
		);
	});
});

describe("parseMcpConfig + mcpSemanticIssues", () => {
	it("requires exactly one hobo MCP server with a single plugin entrypoint arg", () => {
		const extra = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
					evil: {
						type: "stdio",
						command: "node",
						args: ["--eval", "process.exit(0)"],
					},
				},
			}),
		);
		expect(extra.value).toBeDefined();
		if (extra.value === undefined)
			throw new Error("expected parsed MCP config");
		expect(hoboMcpServerIssues(extra.value)).toMatchObject([
			{ message: /exactly the hobo server/u },
		]);
		const evalArgs = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: [
							"--eval",
							"process.exit(0)",
							"${PLUGIN_ROOT}/bin/hobo-mcp.mjs",
						],
					},
				},
			}),
		);
		expect(evalArgs.value).toBeDefined();
		if (evalArgs.value === undefined)
			throw new Error("expected parsed MCP config");
		expect(hoboMcpServerIssues(evalArgs.value)).toEqual([
			{
				file: "mcp.json",
				message: expect.stringMatching(/single argument/u),
			},
		]);
	});

	it("accepts the shipped stdio wiring", () => {
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
		);
		expect(parsed.issues).toEqual([]);
		expect(
			parsed.value !== undefined ? mcpSemanticIssues(parsed.value) : [],
		).toEqual([]);
	});

	it("rejects multi-token commands and unknown fields at parse time", () => {
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node --experimental",
						surprise: 1,
					},
				},
			}),
		);
		const messages = parsed.issues.map((issue) => issue.message).join("\n");
		expect(messages).toMatch(/single executable token/u);
		expect(messages).toMatch(/"surprise" is not allowed/u);
	});

	it("rejects forbidden env keys, secret env keys, and escaping paths semantically", () => {
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/../escape.mjs"],
						env: { PLUGIN_ROOT: "/elsewhere", api_token: "x" },
					},
				},
			}),
		);
		expect(parsed.value).toBeDefined();
		const messages = mcpSemanticIssues(
			parsed.value ?? { $schema: "", mcpServers: {} },
		)
			.map((issue) => issue.message)
			.join("\n");
		expect(messages).toMatch(/traverse outside the plugin root/u);
		expect(messages).toMatch(/"PLUGIN_ROOT" is reserved/u);
		expect(messages).toMatch(/"api_token" names a secret/u);
	});

	it("scans benign env keys for secret-shaped values and rejects env expansion", () => {
		const secret = "ghp_abcdefghijklmnopqrst";
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
						env: {
							BUILD_TOKEN: secret,
							LEAK: "${GITHUB_TOKEN}",
						},
					},
				},
			}),
		);
		expect(parsed.value).toBeDefined();
		const messages = mcpSemanticIssues(
			parsed.value ?? { $schema: "", mcpServers: {} },
		)
			.map((issue) => issue.message)
			.join("\n");
		expect(messages).toMatch(/secret-shaped value/u);
		expect(messages).toMatch(/environment expansion/u);
		expect(messages).not.toContain(secret);
	});

	it("rejects TLS and module-resolution env keys in MCP env", () => {
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
						env: {
							NODE_TLS_REJECT_UNAUTHORIZED: "0",
							NODE_EXTRA_CA_CERTS: "/tmp/evil.pem",
							NODE_PATH: "/tmp/node_modules",
							LD_PRELOAD: "/tmp/evil.so",
							PATH: "/tmp/evil/bin",
						},
					},
				},
			}),
		);
		const messages = mcpSemanticIssues(
			parsed.value ?? { $schema: "", mcpServers: {} },
		)
			.map((issue) => issue.message)
			.join("\n");
		expect(messages).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED.*reserved/u);
		expect(messages).toMatch(/NODE_EXTRA_CA_CERTS.*reserved/u);
		expect(messages).toMatch(/NODE_PATH.*reserved/u);
		expect(messages).toMatch(/LD_PRELOAD.*reserved/u);
		expect(messages).toMatch(/PATH.*reserved/u);
	});

	it("rejects NODE_OPTIONS in MCP env", () => {
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
						env: { NODE_OPTIONS: "--require=evil.js" },
					},
				},
			}),
		);
		expect(parsed.value).toBeDefined();
		const messages = mcpSemanticIssues(
			parsed.value ?? { $schema: "", mcpServers: {} },
		)
			.map((issue) => issue.message)
			.join("\n");
		expect(messages).toMatch(/NODE_OPTIONS.*reserved/u);
	});

	it("rejects unsafe MCP endpoint URLs and expansions", () => {
		for (const url of [
			"http://169.254.169.254/latest/meta-data",
			"https://[::1]/mcp",
			"https://127.0.0.1/mcp",
			"https://metadata.google.internal/mcp",
			"https://${ATTACKER_HOST}/mcp",
			"https://mcp.example.com/a/../b",
			"https://mcp.example.com/%2e%2e/b",
			"https://mcp.example.com/%2E%2e/b",
			"https://mcp.example.com/%2f%2F/b",
			"https://mcp.example.com/%2F%2f/b",
			"https://mcp.example.com/%5c%5C/b",
			"https://mcp.example.com/%5C%5c/b",
			"https://user:pass@mcp.example.com/mcp",
			"https://mcp.example.com.evil.test/mcp",
		]) {
			expect(
				checkMcpEndpointUrl("mcp.json mcpServers.evil", url).map(
					(issue) => issue.message,
				),
			).not.toEqual([]);
		}
		expect(
			checkMcpEndpointUrl(
				"mcp.json mcpServers.ok",
				"https://mcp.example.com/v1/mcp",
			),
		).toEqual([]);
	});

	it("rejects unsafe stdio executables and redacts secret headers", () => {
		for (const command of [
			"/bin/sh",
			"C:\\evil.exe",
			"../../evil",
			"${PLUGIN_ROOT}/../evil",
			"${HOME}/evil",
			"~/evil",
		]) {
			expect(
				checkExecutableToken("mcp.json mcpServers.evil", command).map(
					(issue) => issue.message,
				),
			).not.toEqual([]);
		}
		expect(checkExecutableToken("mcp.json mcpServers.ok", "node")).toEqual([]);
		const parsed = parseMcpConfig(
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					remote: {
						type: "streamable-http",
						url: "http://169.254.169.254/latest/meta-data",
						headers: { Authorization: "ghp_abcdefghijklmnopqrst" },
					},
				},
			}),
		);
		expect(parsed.issues).toEqual([]);
		const messages = mcpSemanticIssues(
			parsed.value ?? { $schema: "", mcpServers: {} },
		)
			.map((issue) => issue.message)
			.join("\n");
		expect(messages).toMatch(/must use https/u);
		expect(messages).toMatch(/secret-shaped value/u);
		expect(messages).not.toContain("ghp_abcdefghijklmnopqrst");
		expect(
			hoboMcpServerIssues(parsed.value ?? { $schema: "", mcpServers: {} }),
		).toMatchObject([{ message: /exactly the hobo server/u }]);
	});
});

describe("scanTextForSecrets", () => {
	it("flags secret-shaped values", () => {
		for (const text of [
			"bearer sk-abcdefghijklmnopqrst",
			"sk-ant-api03-abcdefghijklmnopqrst",
			"sk-or-v1-abcdefghijklmnopqrst",
			"github_token: ghp_abcdefghijklmnopqrst",
			"github_pat_abcdefghijklmnopqrst",
			"sk-proj-abcdefghijklmnopqrst",
		]) {
			expect(scanTextForSecrets("x.json", text)).toHaveLength(1);
		}
	});

	it("accepts the word token in prose without a value", () => {
		expect(
			scanTextForSecrets("x.md", "the token the owner holds stays private"),
		).toEqual([]);
	});
});

describe("checkPluginScopedPath", () => {
	it("allows plugin-rooted and relative paths, blocks escapes", () => {
		expect(checkPluginScopedPath("", "${PLUGIN_ROOT}/bin/x.mjs")).toEqual([]);
		expect(checkPluginScopedPath("", "${PLUGIN_DATA}/cache")).toEqual([]);
		expect(checkPluginScopedPath("", "bin/x.mjs")).toEqual([]);
		for (const value of [
			"/usr/bin/env",
			"C:\\outside",
			"C:Windows",
			"~/outside",
			"~\\outside",
			"${PLUGIN_ROOT}/../x.mjs",
			"./skills/../..",
			"../outside.mjs",
			"foo/../../outside",
			"..\\outside.mjs",
			"foo\\..\\outside",
			"${PLUGIN_ROOT}\\..\\outside.mjs",
		]) {
			expect(checkPluginScopedPath("", value)).toHaveLength(1);
		}
	});

	it("does not echo rejected paths that contain secret-shaped values", () => {
		const secret = "sk-abcdefghijklmnopqrst";
		for (const value of [`/tmp/${secret}`, `\${PLUGIN_ROOT}/../${secret}`]) {
			const messages = checkPluginScopedPath("mcp.json", value)
				.map((issue) => issue.message)
				.join("\n");
			expect(messages).not.toContain(secret);
			expect(messages).not.toContain(value);
		}
	});
});

describe("markdown link containment", () => {
	it("flags escaping and missing links and keeps anchors and URLs", async () => {
		const { pluginRoot } = await scratchPlugin({
			"README.md":
				"[inside](skills/hobo-setup/SKILL.md) [anchor](#top) [site](https://example.com) [escape](../../../docs/agent-tooling.md) [missing](skills/hobo-setup/missing.md)\n",
			"skills/hobo-setup/SKILL.md": "# setup\n",
		});
		const issues = checkMarkdownLinks(pluginRoot, "README.md");
		expect(issues).toHaveLength(2);
		expect(issues[0]?.message).toMatch(/resolves outside the plugin root/u);
		expect(issues[1]?.message).toMatch(/has no local target/u);
	});

	it("redacts every secret-shaped link target in diagnostics", async () => {
		const secrets = ["sk-abcdefghijklmnopqrst", "ghp_abcdefghijklmnopqrst"];
		const { pluginRoot } = await scratchPlugin({
			"README.md": `[escape](../${secrets.join("-")})\n`,
		});
		const messages = checkMarkdownLinks(pluginRoot, "README.md")
			.map((issue) => issue.message)
			.join("\n");
		expect(messages).toMatch(/resolves outside the plugin root/u);
		expect(messages.match(/\[redacted\]/gu)).toHaveLength(2);
		for (const secret of secrets) expect(messages).not.toContain(secret);
	});
});

describe("frontmatter helpers", () => {
	it("splits frontmatter fields from the body", () => {
		const markdown =
			"---\nname: hobo-setup\nmetadata:\n  plugin: hobo\n---\n\n# Body\n";
		expect(parseFrontmatterBlock(markdown)?.get("name")).toBe("hobo-setup");
		expect(bodyAfterFrontmatter(markdown)).toBe("\n# Body\n");
	});
});

describe("checkAgentPlugin (integration)", () => {
	it("validates the repository's real plugin with no issues", async () => {
		const pluginRoot = await buildRealPluginForCheck();
		stubCiOff();
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot,
			versionFromReleaseTrain: undefined,
		});
		expect(report.issues).toEqual([]);
		expect(
			report.notes.some((note) =>
				note.includes("skipped release-train comparison outside CI"),
			),
		).toBe(true);
	});

	it("rejects a newer manifest pin during PR validation", async () => {
		stubCiOff();
		stubCiEnvironment("pull_request");
		const report = await checkAgentPlugin({
			pluginRoot: realPluginRoot,
			repoRoot,
			versionFromReleaseTrain: "0.0.0-alpha.1",
		});
		expect(
			report.issues.some((issue) =>
				/does not exactly match/u.test(issue.message),
			),
		).toBe(true);
	});

	it("uses a Bitwarden alias that throws instead of stubbing secrets", async () => {
		const source = readFileSync(
			path.join(repoRoot, "plugins/hobo/src/bitwarden-sdk-napi.mts"),
			"utf8",
		);
		expect(source).not.toMatch(/secrets\(\)[^{]*\{[^}]*data:\s*\[\]/u);
		const { pluginRoot } = await scratchPlugin({
			"src/bitwarden-sdk-napi.mts": source,
		});
		const portableShim = path.join(pluginRoot, "src/bitwarden-sdk-napi.mts");
		const { BitwardenClient } = await import(pathToFileURL(portableShim).href);
		const client = new BitwardenClient({});
		expect(() => client.secrets()).toThrowError(
			/@bitwarden\/sdk-napi[\s\S]*portable bundle cannot carry/u,
		);
	});

	it("refuses a Bitwarden SDK resolved from an ancestor of a portable plugin", async () => {
		const source = readFileSync(
			path.join(repoRoot, "plugins/hobo/src/bitwarden-sdk-napi.mts"),
			"utf8",
		);
		const { pluginRoot } = await scratchPlugin({
			"src/bitwarden-sdk-napi.mts": source,
		});
		const decoy = path.join(
			pluginRoot,
			"..",
			"node_modules",
			"@bitwarden",
			"sdk-napi",
		);
		await mkdir(decoy, { recursive: true });
		await writeFile(
			path.join(decoy, "package.json"),
			`${JSON.stringify({
				name: "@bitwarden/sdk-napi",
				version: "0.0.0",
				main: "index.js",
			})}\n`,
		);
		await writeFile(
			path.join(decoy, "index.js"),
			"exports.BitwardenClient = class {};\n",
		);
		const portableShim = path.join(pluginRoot, "src/bitwarden-sdk-napi.mts");
		const { BitwardenClient } = await import(pathToFileURL(portableShim).href);
		expect(() => new BitwardenClient({}).secrets()).toThrowError(
			/resolved outside trusted root/u,
		);
	});

	it("fails when a shipped skill drifts from its repo source", async () => {
		const secret = "sk-abcdefghijklmnopqrst";
		const repoSetup = await readFile(
			path.join(repoRoot, ".agents/skills/hobo-setup/SKILL.md"),
			"utf8",
		);
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"skills/hobo-setup/SKILL.md": `---\nname: hobo-setup\ndescription: drifted ${secret}\n---\n\nchanged body\n`,
			"skills/hobo-deploy/SKILL.md":
				"---\nname: hobo-deploy\ndescription: d\n---\n\nbody\n",
			"repo:.agents/skills/hobo-setup/SKILL.md": repoSetup,
			"repo:.agents/skills/hobo-deploy/SKILL.md":
				"---\nname: hobo-deploy\ndescription: d\n---\n\nbody\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		const messages = report.issues.map((issue) => issue.message).join("\n");
		expect(messages).toMatch(/description drifted/u);
		expect(messages).toMatch(/body drifted/u);
		expect(messages).toMatch(/contains a secret-shaped value/u);
		expect(messages).not.toContain(secret);
	});

	it("scans shipped fixtures and plugin src for secret-shaped values", async () => {
		const secret = "ghp_abcdefghijklmnopqrst";
		const big = "x".repeat(1024 * 1024 + 1);
		const setup = "---\nname: hobo-setup\ndescription: d\n---\n\nb\n";
		const deploy = "---\nname: hobo-deploy\ndescription: d\n---\n\nb\n";
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": big,
			"fixtures/deploy/vercel/index.html": `<html>${secret}</html>\n`,
			"src/bitwarden-sdk-napi.mts": `export const x = "${secret}";\n`,
			"skills/hobo-setup/SKILL.md": setup,
			"skills/hobo-deploy/SKILL.md": deploy,
			"repo:.agents/skills/hobo-setup/SKILL.md": setup,
			"repo:.agents/skills/hobo-deploy/SKILL.md": deploy,
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		const files = report.issues
			.filter((issue) => issue.message.includes("secret-shaped"))
			.map((issue) => issue.file);
		expect(files).toContain("fixtures/deploy/vercel/index.html");
		expect(files).toContain("src/bitwarden-sdk-napi.mts");
	});

	it("fails when a repo-only skill ships in the plugin", async () => {
		const setup = "---\nname: hobo-setup\ndescription: d\n---\n\nb\n";
		const deploy = "---\nname: hobo-deploy\ndescription: d\n---\n\nb\n";
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { hobo: { type: "stdio", command: "node" } },
			}),
			"README.md": "# hobo\n",
			"skills/hobo-setup/SKILL.md": setup,
			"skills/hobo-deploy/SKILL.md": deploy,
			"skills/verify-cd-fanout/SKILL.md":
				"---\nname: verify-cd-fanout\ndescription: repo internal\n---\n\nb\n",
			"repo:.agents/skills/hobo-setup/SKILL.md": setup,
			"repo:.agents/skills/hobo-deploy/SKILL.md": deploy,
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some((issue) =>
				/the portable set is exactly/.test(issue.message),
			),
		).toBe(true);
	});

	it("compares recursive skill file sets in both directions", async () => {
		const secret = "sk-abcdefghijklmnopqrst";
		const setup = "---\nname: hobo-setup\ndescription: d\n---\n\nb\n";
		const deploy = "---\nname: hobo-deploy\ndescription: d\n---\n\nb\n";
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { hobo: { type: "stdio", command: "node" } },
			}),
			"README.md": "# hobo\n",
			"skills/hobo-setup/SKILL.md": setup,
			"skills/hobo-deploy/SKILL.md": deploy,
			"skills/hobo-setup/references/agent-tooling.md": `${AGENT_TOOLING_HEADING}\n\nbody\n`,
			"skills/hobo-setup/references/extra.md": "plugin-only file\n",
			"skills/hobo-deploy/assets/deep/logo.svg": "<svg/>\n",
			"skills/hobo-deploy/notes-secret-shaped.md": `plugin-only nested ${secret}\n`,
			"repo:.agents/skills/hobo-setup/SKILL.md": setup,
			"repo:.agents/skills/hobo-deploy/SKILL.md": deploy,
			"repo:.agents/skills/hobo-setup/references/agent-tooling.md": `${AGENT_TOOLING_HEADING}\n\nbody\n`,
			"repo:.agents/skills/hobo-setup/references/repo-only.md": "repo only\n",
			"repo:.agents/skills/hobo-deploy/assets/deep/repo-only.md": "repo only\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		const unmatched = report.issues.filter((issue) =>
			/no mirrored \.agents\/skills\/hobo-(?:setup|deploy) source/.test(
				issue.message,
			),
		);
		expect(unmatched.map((issue) => issue.file).sort()).toEqual([
			"skills/hobo-deploy/assets/deep/logo.svg",
			"skills/hobo-deploy/notes-secret-shaped.md",
			"skills/hobo-setup/references/extra.md",
		]);
		const missing = report.issues.filter((issue) =>
			/is missing from the plugin but exists in/.test(issue.message),
		);
		expect(missing.map((issue) => issue.file).sort()).toEqual([
			"skills/hobo-deploy/assets/deep/repo-only.md",
			"skills/hobo-setup/references/repo-only.md",
		]);
		expect(JSON.stringify(report)).not.toContain(secret);
		expect(unmatched.every((issue) => !issue.message.includes(secret))).toBe(
			true,
		);
	});

	it("scans every shipped skill file for secrets, not only SKILL.md", async () => {
		const secret = "github_pat_abcdefghijklmnopqrst";
		const setup = "---\nname: hobo-setup\ndescription: d\n---\n\nb\n";
		const deploy = "---\nname: hobo-deploy\ndescription: d\n---\n\nb\n";
		const notes = `token: ${secret}\n`;
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { hobo: { type: "stdio", command: "node" } },
			}),
			"README.md": "# hobo\n",
			"skills/hobo-setup/SKILL.md": setup,
			"skills/hobo-deploy/SKILL.md": deploy,
			"skills/hobo-setup/references/agent-tooling.md": `${AGENT_TOOLING_HEADING}\n\nbody\n`,
			"skills/hobo-deploy/references/notes.md": notes,
			"repo:.agents/skills/hobo-setup/SKILL.md": setup,
			"repo:.agents/skills/hobo-deploy/SKILL.md": deploy,
			"repo:.agents/skills/hobo-setup/references/agent-tooling.md": `${AGENT_TOOLING_HEADING}\n\nbody\n`,
			"repo:.agents/skills/hobo-deploy/references/notes.md": notes,
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		const secretIssues = report.issues.filter((issue) =>
			issue.message.includes("secret-shaped"),
		);
		expect(secretIssues.map((issue) => issue.file)).toEqual([
			"skills/hobo-deploy/references/notes.md",
		]);
		expect(secretIssues[0]?.message).not.toContain(secret);
	});

	it("binds the MCP entrypoint to the plugin-rooted bundle", async () => {
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/other.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some(
				(issue) =>
					issue.file === "mcp.json" &&
					issue.message.includes(
						"single argument ${PLUGIN_ROOT}/bin/hobo-mcp.mjs",
					),
			),
		).toBe(true);
	});

	it("fails closed for missing and tiny bundles in CI", async () => {
		stubCiOff();
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
		});
		await mkdir(path.join(pluginRoot, "bin"), { recursive: true });
		for (const variable of ["CI", "GITHUB_ACTIONS", "TF_BUILD"]) {
			vi.stubEnv(variable, "1");
			const missing = await checkAgentPlugin({
				pluginRoot,
				repoRoot: scratchRepo,
			});
			expect(
				missing.issues.some(
					(issue) =>
						issue.file === "bin/hobo-mcp.mjs" &&
						issue.message.includes("is missing"),
				),
			).toBe(true);
			await writeFile(path.join(pluginRoot, "bin/hobo-mcp.mjs"), "tiny");
			const tiny = await checkAgentPlugin({
				pluginRoot,
				repoRoot: scratchRepo,
			});
			expect(
				tiny.issues.some(
					(issue) =>
						issue.file === "bin/hobo-mcp.mjs" &&
						issue.message.includes("is only 4 bytes"),
				),
			).toBe(true);
			await rm(path.join(pluginRoot, "bin/hobo-mcp.mjs"));
			vi.stubEnv(variable, undefined);
		}
	});

	it("rejects symbolic links in the shipped plugin tree", async () => {
		stubCiOff();
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": `${"x".repeat(1024 * 1024)}\n`,
			"fixtures/deploy/vercel/package.json": "{}\n",
		});
		await writeFile(path.join(pluginRoot, "target.txt"), "secret-free\n");
		await symlink(
			path.join(pluginRoot, "target.txt"),
			path.join(pluginRoot, "leak-link.txt"),
		);
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some((issue) =>
				/symbolic links are not allowed/u.test(issue.message),
			),
		).toBe(true);
	});

	it("scans an existing plugin-rooted bundle for secrets", async () => {
		stubCiOff();
		const secret = `github_pat_${"a".repeat(20)}`;
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": `${"x".repeat(1024 * 1024)}\n${secret}\n`,
			"fixtures/deploy/vercel/package.json": "{}\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		const bundleIssues = report.issues.filter(
			(issue) => issue.file === "bin/hobo-mcp.mjs",
		);
		expect(bundleIssues).toHaveLength(1);
		expect(bundleIssues[0]?.message).toContain("secret-shaped value");
		expect(bundleIssues[0]?.message).not.toContain(secret);
	});

	it("pins gh verification to the trusted main workflow, source digest, and current run certificate", async () => {
		stubCiOff();
		vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
		vi.stubEnv("GITHUB_REPOSITORY", "Hobo-Labs/HoBo");
		const expected = {
			bundlePath: "/tmp/hobo-mcp.mjs",
			runId: "run-current",
			runAttempt: "1",
			commitSha: "commit-current",
		};
		const attestation = (
			overrides: {
				runAttempt?: string;
				signerRef?: string;
				signerDigest?: string;
			} = {},
		) =>
			JSON.stringify([
				{
					verificationResult: {
						signature: {
							certificate: {
								extensions: {
									buildSignerURI: `https://github.com/Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@${overrides.signerRef ?? "refs/heads/main"}`,
									buildSignerDigest:
										overrides.signerDigest ?? expected.commitSha,
									runInvocationID: `https://github.com/Hobo-Labs/HoBo/actions/runs/run-current/attempts/${overrides.runAttempt ?? "1"}`,
								},
							},
						},
					},
				},
			]);
		const calls: Array<{ command: string; args: readonly string[] }> = [];
		await expect(
			verifyAgentPluginAttestation(expected, (command, args) => {
				calls.push({ command, args });
				return { status: 0, stdout: attestation() };
			}),
		).resolves.toBeUndefined();
		expect(calls).toEqual([
			{
				command: "gh",
				args: [
					"attestation",
					"verify",
					"/tmp/hobo-mcp.mjs",
					"--repo",
					"Hobo-Labs/HoBo",
					"--signer-workflow",
					"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml",
					"--cert-identity",
					"https://github.com/Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/heads/main",
					"--cert-oidc-issuer",
					"https://token.actions.githubusercontent.com",
					"--source-digest",
					"commit-current",
					"--format",
					"json",
				],
			},
		]);
		await expect(
			verifyAgentPluginAttestation(expected, () => ({
				status: 0,
				stdout: attestation({ runAttempt: "0" }),
			})),
		).rejects.toThrow("not from this workflow run attempt");
		for (const overrides of [
			{ signerRef: "refs/pull/2913/head" },
			{ signerDigest: "attacker-controlled-commit" },
		]) {
			await expect(
				verifyAgentPluginAttestation(expected, () => ({
					status: 0,
					stdout: attestation(overrides),
				})),
			).rejects.toThrow("not from hobo-ci.yml on refs/heads/main");
		}
		await expect(
			verifyAgentPluginAttestation(expected, () => ({
				status: 1,
				stdout: "",
			})),
		).rejects.toThrow("verification failed");
	});

	it("rejects a bundle in CI that is not running on GitHub Actions", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", undefined);
		const bundleBody = "z".repeat(1024 * 1024);
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": bundleBody,
			"fixtures/deploy/vercel/package.json": "{}\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some((issue) =>
				/only verified in GitHub Actions/u.test(issue.message),
			),
		).toBe(true);
	});

	it("rejects a bundle without verified artifact provenance in GitHub Actions", async () => {
		stubCiOff();
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GH_TOKEN", "caller-controlled");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
		vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
		const bundleBody = "w".repeat(1024 * 1024);
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": bundleBody,
			"fixtures/deploy/vercel/package.json": "{}\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
			verifyAttestation: async () => {
				throw new Error("no attestation");
			},
		});
		expect(
			report.issues.some((issue) =>
				/no verified GitHub artifact provenance/u.test(issue.message),
			),
		).toBe(true);
	});

	it("binds non-publishing bundles to the current event, run, attempt, commit, and digest", async () => {
		stubCiOff();
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
		vi.stubEnv("GITHUB_SHA", "a".repeat(40));
		const bundleBody = "x".repeat(1024 * 1024);
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"bin/hobo-mcp.mjs": bundleBody,
			"fixtures/deploy/vercel/package.json": "{}\n",
		});
		const markerPath = path.join(
			pluginRoot,
			".agent-plugin-nonpublishing.json",
		);
		const digest = createHash("sha256").update(bundleBody).digest("hex");
		for (const eventName of ["pull_request", "merge_group"] as const) {
			vi.stubEnv("GITHUB_EVENT_NAME", eventName);
			await rm(markerPath, { force: true });
			let verified = false;
			const verifyAttestation = async () => {
				verified = true;
			};
			const missing = await checkAgentPlugin({
				pluginRoot,
				repoRoot: scratchRepo,
				verifyAttestation,
			});
			expect(
				missing.issues.some(
					(issue) =>
						issue.file === ".agent-plugin-nonpublishing.json" &&
						/requires a bundle marker/u.test(issue.message),
				),
			).toBe(true);
			const marker = {
				publishable: false,
				reason: eventName,
				runId: "run-current",
				runAttempt: "1",
				commitSha: "a".repeat(40),
				digest,
			};
			await writeFile(markerPath, JSON.stringify(marker));
			const report = await checkAgentPlugin({
				pluginRoot,
				repoRoot: scratchRepo,
				verifyAttestation,
			});
			expect(verified).toBe(false);
			expect(
				report.issues.filter(
					(issue) => issue.file === ".agent-plugin-nonpublishing.json",
				),
			).toEqual([]);
			expect(
				report.notes.some((note) =>
					/non-publishing PR validation rebuilt and checked/u.test(note),
				),
			).toBe(true);
			for (const changes of [
				{ publishable: true },
				{
					reason: eventName === "pull_request" ? "merge_group" : "pull_request",
				},
				{ runId: "run-previous" },
				{ runAttempt: "2" },
				{ commitSha: "b".repeat(40) },
				{ digest: createHash("sha256").update("stale").digest("hex") },
			]) {
				await writeFile(markerPath, JSON.stringify({ ...marker, ...changes }));
				const stale = await checkAgentPlugin({
					pluginRoot,
					repoRoot: scratchRepo,
					verifyAttestation,
				});
				expect(
					stale.issues.some(
						(issue) =>
							issue.file === ".agent-plugin-nonpublishing.json" &&
							/not a valid|does not bind/u.test(issue.message),
					),
				).toBe(true);
			}
		}
	});

	it("does not let retired environment switches bypass trusted verification", async () => {
		stubCiOff();
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_EVENT_NAME", "push");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
		vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
		vi.stubEnv("HOBO_AGENT_PLUGIN_ATTESTED_EXTERNALLY", "1");
		vi.stubEnv("HOBO_AGENT_PLUGIN_VERIFY", "1");
		vi.stubEnv("GH_TOKEN", "caller-controlled");
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"bin/hobo-mcp.mjs": "x".repeat(1024 * 1024),
			"fixtures/deploy/vercel/package.json": "{}\n",
		});
		let verified = false;
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
			verifyAttestation: async () => {
				verified = true;
				throw new Error("not signed by GitHub");
			},
		});
		expect(verified).toBe(true);
		expect(
			report.issues.some((issue) =>
				/no verified GitHub artifact provenance/u.test(issue.message),
			),
		).toBe(true);
	});

	it("rejects legacy bearer-token attestation records", async () => {
		stubCiOff();
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
		vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
		const bundleBody = "v".repeat(1024 * 1024);
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": bundleBody,
			"fixtures/deploy/vercel/package.json": "{}\n",
			".bundle-attestation.json": "{ not json\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some(
				(issue) =>
					issue.file === ".bundle-attestation.json" &&
					/legacy bearer-token record/u.test(issue.message),
			),
		).toBe(true);
	});

	it("accepts only verified provenance from the current workflow attempt", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GH_TOKEN", "caller-controlled");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
		vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
		const bundleBody = "y".repeat(1024 * 1024);
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": bundleBody,
			"fixtures/deploy/vercel/package.json": "{}\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
			verifyAttestation: async (expected) => {
				expect(expected).toEqual({
					bundlePath: path.join(pluginRoot, "bin/hobo-mcp.mjs"),
					runId: "run-current",
					runAttempt: "1",
					commitSha: "commit-current",
				});
			},
		});
		expect(
			report.issues.filter((issue) => /provenance/u.test(issue.message)),
		).toEqual([]);
		const forged = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
			verifyAttestation: async () => {
				throw new Error("not signed by GitHub");
			},
		});
		expect(
			forged.issues.some((issue) =>
				/no verified GitHub artifact provenance/u.test(issue.message),
			),
		).toBe(true);
		const previousAttempt = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
			verifyAttestation: async () => {
				throw new Error("attestation is from attempt 0");
			},
		});
		expect(
			previousAttempt.issues.some((issue) =>
				/no verified GitHub artifact provenance/u.test(issue.message),
			),
		).toBe(true);
	});

	it("requires GitHub run and attempt metadata in CI", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GH_TOKEN", "caller-controlled");
		vi.stubEnv("GITHUB_RUN_ID", undefined);
		vi.stubEnv("GITHUB_SHA", "commit-current");
		vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
		const bundleBody = "x".repeat(1024 * 1024);
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": bundleBody,
			"fixtures/deploy/vercel/package.json": "{}\n",
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some((issue) => /GITHUB_RUN_ID/u.test(issue.message)),
		).toBe(true);
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_RUN_ATTEMPT", undefined);
		const withoutAttempt = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			withoutAttempt.issues.some((issue) =>
				/GITHUB_RUN_ATTEMPT/u.test(issue.message),
			),
		).toBe(true);
		vi.unstubAllEnvs();
	});

	it("rejects a bundle without deploy fixtures", async () => {
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					hobo: {
						type: "stdio",
						command: "node",
						args: ["${PLUGIN_ROOT}/bin/hobo-mcp.mjs"],
					},
				},
			}),
			"README.md": "# hobo\n",
			"bin/hobo-mcp.mjs": "x".repeat(1024 * 1024),
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some(
				(issue) =>
					issue.file === "fixtures/deploy" && issue.message.includes("empty"),
			),
		).toBe(true);
	});

	it("pins vendored schema digests from MANIFEST.sha256", async () => {
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { hobo: { type: "stdio", command: "node" } },
			}),
			"README.md": "# hobo\n",
		});
		const schemaDir = path.join(
			scratchRepo,
			"tools/agent-plugins/schemas/1.0.0",
		);
		const secret = `github_pat_${"a".repeat(20)}`;
		await mkdir(schemaDir, { recursive: true });
		await writeFile(
			path.join(schemaDir, "MANIFEST.sha256"),
			`${"a".repeat(64)}  plugin.schema.json\n${secret}\n`,
		);
		await writeFile(
			path.join(schemaDir, "plugin.schema.json"),
			`{"$id":"${"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"}"}\n`,
		);
		await writeFile(
			path.join(schemaDir, "mcp.schema.json"),
			`{"$id":"${"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"}"}\n`,
		);
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some((issue) => issue.message.includes("MANIFEST.sha256")),
		).toBe(true);
		expect(
			report.issues.some((issue) =>
				issue.message.includes("invalid entry at line 2"),
			),
		).toBe(true);
		expect(
			report.issues.map((issue) => issue.message).join("\n"),
		).not.toContain(secret);
	});
});

describe("agent-tooling extract drift gate", () => {
	it("keeps the shipped reference in sync with the docs section", async () => {
		const issues = agentToolingReferenceDriftIssues({
			docsMarkdown: await readFile(
				path.join(repoRoot, "docs/agent-tooling.md"),
				"utf8",
			),
			referenceMarkdown: await readFile(
				path.join(
					realPluginRoot,
					"skills/hobo-setup/references/agent-tooling.md",
				),
				"utf8",
			),
		});
		expect(issues).toEqual([]);
	});

	it("flags a docs edit that is not re-extracted into the reference", async () => {
		const docsMarkdown = (
			await readFile(path.join(repoRoot, "docs/agent-tooling.md"), "utf8")
		).replace(
			"Registration alone does not establish",
			"Registration by itself no longer establishes",
		);
		const referenceMarkdown = await readFile(
			path.join(
				realPluginRoot,
				"skills/hobo-setup/references/agent-tooling.md",
			),
			"utf8",
		);
		const issues = agentToolingReferenceDriftIssues({
			docsMarkdown,
			referenceMarkdown,
		});
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/drifted from docs\/agent-tooling\.md/u);
	});

	it("does not echo secret-shaped drift windows in diagnostics", async () => {
		const secret = "sk-ant-api03-abcdefghijklmnopqrst";
		const docsMarkdown = (
			await readFile(path.join(repoRoot, "docs/agent-tooling.md"), "utf8")
		).replace(
			"Registration alone does not establish",
			`keep ${secret} here; Registration by itself no longer establishes`,
		);
		const referenceMarkdown = await readFile(
			path.join(
				realPluginRoot,
				"skills/hobo-setup/references/agent-tooling.md",
			),
			"utf8",
		);
		const messages = agentToolingReferenceDriftIssues({
			docsMarkdown,
			referenceMarkdown,
		})
			.map((issue) => issue.message)
			.join("\n");
		expect(messages).toMatch(/drifted from docs\/agent-tooling\.md/u);
		expect(messages).not.toContain(secret);
	});

	it("requires docs links into .agents/skills/hobo-setup to be rewritten plugin-relative", async () => {
		const docsMarkdown = await readFile(
			path.join(repoRoot, "docs/agent-tooling.md"),
			"utf8",
		);
		const referenceMarkdown = (
			await readFile(
				path.join(
					realPluginRoot,
					"skills/hobo-setup/references/agent-tooling.md",
				),
				"utf8",
			)
		).replace("(../SKILL.md)", "(../.agents/skills/hobo-setup/SKILL.md)");
		const issues = agentToolingReferenceDriftIssues({
			docsMarkdown,
			referenceMarkdown,
		});
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/drifted from docs\/agent-tooling\.md/u);
	});

	it("rejects an unknown annotation where a repo-only marker belongs", async () => {
		const docsMarkdown = await readFile(
			path.join(repoRoot, "docs/agent-tooling.md"),
			"utf8",
		);
		const referenceMarkdown = await readFile(
			path.join(
				realPluginRoot,
				"skills/hobo-setup/references/agent-tooling.md",
			),
			"utf8",
		);
		const marker =
			"Commands marked **repo-only** need the HoBo repository checkout.";
		const mutated = referenceMarkdown.includes(marker)
			? referenceMarkdown.replace(
					marker,
					"Commands marked **repo only** need the HoBo repository checkout.",
				)
			: `${referenceMarkdown}\n<!-- drift -->\n`;
		const issues = agentToolingReferenceDriftIssues({
			docsMarkdown,
			referenceMarkdown: mutated,
		});
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/drifted from docs\/agent-tooling\.md/u);
	});

	it("does not exclude reference body lines between Source and the first blank line", () => {
		const body = "Docs body with tooling links.";
		const docs = `# Agent tooling\n\n${AGENT_TOOLING_HEADING}\n\n${body}\n`;
		const reference = `${AGENT_TOOLING_HEADING}\n\nSource: extracted from docs/agent-tooling.md.\nInjected drift that must fail.\n\n${body}\n`;
		expect(
			agentToolingReferenceDriftIssues({
				docsMarkdown: docs,
				referenceMarkdown: reference,
			}),
		).not.toEqual([]);
	});

	it("reports a missing docs section and a replaced reference heading", () => {
		expect(
			agentToolingReferenceDriftIssues({
				docsMarkdown: "# Agent tooling\n\n### other — tool\n\nbody\n",
				referenceMarkdown: `${AGENT_TOOLING_HEADING}\n\nbody\n`,
			})[0]?.message,
		).toMatch(/section "### hobo/u);
		expect(
			agentToolingReferenceDriftIssues({
				docsMarkdown: `# Agent tooling\n\n${AGENT_TOOLING_HEADING}\n\nbody\n`,
				referenceMarkdown: "### hobo MCP server\n\nbody\n",
			})[0]?.message,
		).toMatch(/must start with the heading/u);
	});

	it("fails through checkAgentPlugin when the extract drifts from docs", async () => {
		const setup = "---\nname: hobo-setup\ndescription: d\n---\n\nb\n";
		const deploy = "---\nname: hobo-deploy\ndescription: d\n---\n\nb\n";
		const docs = `# Agent tooling\n\n${AGENT_TOOLING_HEADING}\n\nDocs body with the [HoBo setup skill](../.agents/skills/hobo-setup/SKILL.md).\n\n### next — tool\n\nafter\n`;
		const reference = `${AGENT_TOOLING_HEADING}\n\nSource: extracted from docs/agent-tooling.md.\n\nDocs body with the [HoBo setup skill](../SKILL.md) (repo-only).\n`;
		const { pluginRoot, repoRoot: scratchRepo } = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { hobo: { type: "stdio", command: "node" } },
			}),
			"README.md": "# hobo\n",
			"skills/hobo-setup/SKILL.md": setup,
			"skills/hobo-deploy/SKILL.md": deploy,
			"skills/hobo-setup/references/agent-tooling.md": reference.replace(
				"Docs body with",
				"Changed body with",
			),
			"repo:.agents/skills/hobo-setup/SKILL.md": setup,
			"repo:.agents/skills/hobo-deploy/SKILL.md": deploy,
			"repo:docs/agent-tooling.md": docs,
		});
		const report = await checkAgentPlugin({
			pluginRoot,
			repoRoot: scratchRepo,
		});
		expect(
			report.issues.some((issue) =>
				/drifted from docs\/agent-tooling\.md/u.test(issue.message),
			),
		).toBe(true);
		const inSync = await scratchPlugin({
			"plugin.json": JSON.stringify(validManifest),
			"mcp.json": JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { hobo: { type: "stdio", command: "node" } },
			}),
			"README.md": "# hobo\n",
			"skills/hobo-setup/SKILL.md": setup,
			"skills/hobo-deploy/SKILL.md": deploy,
			"skills/hobo-setup/references/agent-tooling.md": reference,
			"repo:.agents/skills/hobo-setup/SKILL.md": setup,
			"repo:.agents/skills/hobo-deploy/SKILL.md": deploy,
			"repo:docs/agent-tooling.md": docs,
		});
		const cleanReport = await checkAgentPlugin({
			pluginRoot: inSync.pluginRoot,
			repoRoot: inSync.repoRoot,
		});
		expect(
			cleanReport.issues.filter((issue) =>
				issue.message.includes("agent-tooling"),
			),
		).toEqual([]);
	});
});

describe("release-train version pin commit selection", () => {
	it("uses HEAD^2 on PR events when GITHUB_HEAD_SHA matches the PR branch tip", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		stubCiEnvironment("merge_group", prHead);
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
		stubCiEnvironment("pull_request", prHead);
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
	});

	it("rejects a verified GITHUB_HEAD_SHA that is not the PR branch tip", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		const baseSha = git(repoRoot, "rev-parse", "HEAD^1");
		stubCiEnvironment("pull_request", baseSha);
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
		expect(githubHeadShaMismatchIssues(repoRoot)).toHaveLength(1);
	});

	it("fails checkAgentPlugin when GITHUB_HEAD_SHA disagrees with HEAD^2", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		const baseSha = git(repoRoot, "rev-parse", "HEAD^1");
		stubCiEnvironment("pull_request", baseSha);
		const report = await checkAgentPlugin({
			pluginRoot: realPluginRoot,
			repoRoot,
			versionFromReleaseTrain: undefined,
		});
		expect(
			report.issues.some((issue) =>
				/GITHUB_HEAD_SHA does not match the PR branch tip/u.test(issue.message),
			),
		).toBe(true);
		expect(prHead).not.toBe(baseSha);
	});

	it("ignores an unverified GITHUB_HEAD_SHA", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		stubCiEnvironment("pull_request", "b".repeat(40));
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
	});

	it("resolves the PR branch tip from GITHUB_SHA^2 on a head-sha checkout", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		const mergeSha = git(repoRoot, "rev-parse", "HEAD");
		git(repoRoot, "checkout", "-q", "pr");
		stubCiEnvironment("pull_request");
		vi.stubEnv("GITHUB_SHA", mergeSha);
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
		expect(githubHeadShaMismatchIssues(repoRoot)).toEqual([]);
	});

	it("resolves and cross-checks the PR branch tip from the event payload", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		const eventPath = path.join(repoRoot, "event.json");
		await writeFile(
			eventPath,
			JSON.stringify({ pull_request: { head: { sha: prHead } } }),
		);
		stubCiEnvironment("pull_request");
		vi.stubEnv("GITHUB_EVENT_PATH", eventPath);
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
		expect(githubHeadShaMismatchIssues(repoRoot)).toEqual([]);
	});

	it("refuses disagreeing PR branch tip sources", async () => {
		const { repoRoot } = await scratchMergeRepo();
		const baseSha = git(repoRoot, "rev-parse", "HEAD^1");
		const eventPath = path.join(repoRoot, "event.json");
		await writeFile(
			eventPath,
			JSON.stringify({ pull_request: { head: { sha: baseSha } } }),
		);
		stubCiEnvironment("pull_request");
		vi.stubEnv("GITHUB_EVENT_PATH", eventPath);
		expect(
			githubHeadShaMismatchIssues(repoRoot).some((issue) =>
				/PR branch tip sources disagree/u.test(issue.message),
			),
		).toBe(true);
	});

	it("resolves the PR branch tip (HEAD^2) for pull_request and merge_group checkouts", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		stubCiEnvironment("pull_request");
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
		stubCiEnvironment("merge_group");
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
	});

	it("falls back to HEAD outside PR events or on a non-merge checkout", async () => {
		const { repoRoot } = await scratchMergeRepo();
		stubCiEnvironment("push");
		expect(versionPinCommitIsh(repoRoot)).toBe("HEAD");
		stubCiEnvironment("workflow_dispatch");
		expect(versionPinCommitIsh(repoRoot)).toBe("HEAD");
		const root = await mkdtemp(path.join(tmpdir(), "hobo-agent-plugin-git-"));
		scratches.push(root);
		git(root, "init", "-q");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test");
		git(root, "config", "commit.gpgsign", "false");
		await writeFile(path.join(root, "seed.txt"), "seed\n");
		git(root, "add", "seed.txt");
		git(root, "commit", "-q", "-m", "only commit");
		stubCiEnvironment("merge_group");
		expect(versionPinCommitIsh(root)).toBe("HEAD");
		expect(githubHeadShaMismatchIssues(root)).toEqual([
			expect.objectContaining({
				message:
					"cannot resolve the PR branch tip from HEAD^2, GITHUB_SHA^2, the event payload, or GITHUB_HEAD_SHA; refuse version measurement",
			}),
		]);
	});

	it("fails checkAgentPlugin when pull_request lacks HEAD^2", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "hobo-agent-plugin-git-"));
		scratches.push(root);
		git(root, "init", "-q");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test");
		git(root, "config", "commit.gpgsign", "false");
		await writeFile(path.join(root, "seed.txt"), "seed\n");
		git(root, "add", "seed.txt");
		git(root, "commit", "-q", "-m", "only commit");
		stubCiEnvironment("pull_request");
		const report = await checkAgentPlugin({
			pluginRoot: realPluginRoot,
			repoRoot: root,
			versionFromReleaseTrain: undefined,
		});
		expect(
			report.issues.some((issue) =>
				/cannot resolve the PR branch tip from HEAD\^2/u.test(issue.message),
			),
		).toBe(true);
	});

	it("measures the height at the PR branch tip, not the inflated merge ref", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		stubCiEnvironment("merge_group");
		const recorder = recordingNbgv("5");
		expect(releaseTrainSemverForPluginCheck(repoRoot, recorder.nbgv)).toBe(
			"0.0.0-alpha.8",
		);
		expect(recorder.calls).toEqual([
			{ variable: "VersionHeight", commitIsh: prHead },
		]);
	});

	it("rejects empty nbgv VersionHeight output", async () => {
		const { repoRoot } = await scratchMergeRepo();
		stubCiEnvironment("push");
		expect(() =>
			releaseTrainSemverForPluginCheck(repoRoot, () => "   "),
		).toThrow(/empty VersionHeight output/u);
	});

	it("bumps the expected height only for a locally staged plugin.json at HEAD", async () => {
		const { repoRoot } = await scratchMergeRepo();
		await mkdir(path.join(repoRoot, "plugins/hobo"), { recursive: true });
		await writeFile(
			path.join(repoRoot, "plugins/hobo/plugin.json"),
			JSON.stringify(validManifest),
		);
		git(repoRoot, "add", "plugins/hobo/plugin.json");
		stubCiEnvironment("push");
		const localStaged = recordingNbgv("5");
		expect(releaseTrainSemverForPluginCheck(repoRoot, localStaged.nbgv)).toBe(
			"0.0.0-alpha.9",
		);
		expect(localStaged.calls).toEqual([
			{ variable: "VersionHeight", commitIsh: "HEAD" },
		]);
		git(repoRoot, "restore", "--staged", "plugins/hobo/plugin.json");
		const untouched = recordingNbgv("5");
		expect(releaseTrainSemverForPluginCheck(repoRoot, untouched.nbgv)).toBe(
			"0.0.0-alpha.8",
		);
	});

	it("fails closed unless an explicit local-only override is set", () => {
		const failingNbgv = () => {
			throw new Error("nbgv unavailable");
		};
		stubCiOff();
		vi.stubEnv("HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN", undefined);
		expect(() =>
			releaseTrainVersionForPluginGate(repoRoot, failingNbgv),
		).toThrow("nbgv unavailable");
		vi.stubEnv("HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN", "1");
		expect(
			releaseTrainVersionForPluginGate(repoRoot, failingNbgv),
		).toBeUndefined();
		for (const [variable, value] of [
			["CI", "1"],
			["GITHUB_ACTIONS", "true"],
			["TF_BUILD", "true"],
		] as const) {
			vi.stubEnv(variable, value);
			expect(() =>
				releaseTrainVersionForPluginGate(repoRoot, failingNbgv),
			).toThrow("HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN is not allowed in CI");
			vi.stubEnv(variable, undefined);
		}
	});

	it("rejects HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN in CI even when nbgv succeeds", () => {
		const succeedingNbgv = () => "5";
		vi.stubEnv("HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN", "1");
		vi.stubEnv("CI", "1");
		expect(() =>
			releaseTrainVersionForPluginGate(repoRoot, succeedingNbgv),
		).toThrow("HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN is not allowed in CI");
		vi.stubEnv("CI", undefined);
		vi.stubEnv("HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN", undefined);
	});

	it("rejects a shallow checkout before measuring release-train height", async () => {
		const { repoRoot } = await scratchMergeRepo();
		await writeFile(path.join(repoRoot, ".git/shallow"), "");
		expect(() => releaseTrainSemverForPluginCheck(repoRoot, () => "5")).toThrow(
			/shallow checkout refused/u,
		);
	});

	it("validates the staged plugin.json blob, not a differing working-tree file", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "hobo-plugin-staged-"));
		scratches.push(root);
		git(root, "init", "-q");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test");
		const stagedDir = path.join(root, "plugins/hobo");
		await mkdir(stagedDir, { recursive: true });
		const real = parsePluginManifest(
			readFileSync(path.join(realPluginRoot, "plugin.json"), "utf8"),
		).value;
		if (real === undefined) throw new Error("real plugin.json did not parse");
		await writeFile(
			path.join(stagedDir, "plugin.json"),
			`${JSON.stringify({ ...real, version: "0.0.0-alpha.1" })}\n`,
		);
		git(root, "add", "plugins/hobo/plugin.json");
		await writeFile(
			path.join(stagedDir, "plugin.json"),
			`${JSON.stringify({ ...real, version: real.version })}\n`,
		);
		stubCiOff();
		const report = await checkAgentPlugin({
			pluginRoot: realPluginRoot,
			repoRoot: root,
			versionFromReleaseTrain: real.version,
		});
		expect(
			report.issues.some(
				(issue) =>
					issue.file === "plugin.json" &&
					/does not exactly match/u.test(issue.message),
			),
		).toBe(true);
	});
});
