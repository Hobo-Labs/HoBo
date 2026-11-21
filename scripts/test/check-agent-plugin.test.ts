import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AGENT_TOOLING_HEADING,
	agentToolingReferenceDriftIssues,
	bodyAfterFrontmatter,
	checkAgentPlugin,
	checkMarkdownLinks,
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
	requiresExactReleaseTrainVersion,
	scanTextForSecrets,
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
}

function stubCiOff() {
	for (const variable of ["CI", "GITHUB_ACTIONS", "TF_BUILD"] as const) {
		vi.stubEnv(variable, undefined);
	}
	vi.stubEnv("GITHUB_RUN_ID", undefined);
	vi.stubEnv("GITHUB_SHA", undefined);
	vi.stubEnv("GITHUB_RUN_ATTEMPT", undefined);
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
		expect(issues[0]?.message).toMatch(/is stale/u);
	});

	it("flags a numeric-prerelease pin that is strictly older, not lexically older", () => {
		const issues = manifestSemanticIssues(
			{ ...validManifest, version: "0.0.0-alpha.9" },
			"0.0.0-alpha.400",
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/is stale/u);
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

	it("tolerates a one-height squash merge lag on push outside exact PR pins", () => {
		vi.stubEnv("GITHUB_EVENT_NAME", "push");
		expect(
			manifestSemanticIssues(
				{ ...validManifest, version: "0.0.0-alpha.399" },
				"0.0.0-alpha.400",
			),
		).toEqual([]);
		expect(
			manifestSemanticIssues(
				{ ...validManifest, version: "0.0.0-alpha.398" },
				"0.0.0-alpha.400",
			),
		).toHaveLength(1);
		vi.unstubAllEnvs();
	});

	it("rejects a newer height when PR validation requires an exact pin", () => {
		const issues = manifestSemanticIssues(
			{ ...validManifest, version: "0.0.0-alpha.500" },
			"0.0.0-alpha.400",
			{ exactReleaseTrain: true },
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/is newer than the release train/u);
	});

	it("rejects a newer height on push outside the one-height squash lag", () => {
		vi.stubEnv("GITHUB_EVENT_NAME", "push");
		const issues = manifestSemanticIssues(
			{ ...validManifest, version: "0.0.0-alpha.500" },
			"0.0.0-alpha.400",
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(
			/ahead-of-train pins are never allowed/u,
		);
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
	it("flags links that escape the plugin root and keeps anchors and URLs", async () => {
		const { pluginRoot } = await scratchPlugin({
			"README.md":
				"[inside](skills/hobo-setup/SKILL.md) [anchor](#top) [site](https://example.com) [escape](../../../docs/agent-tooling.md)\n",
		});
		const issues = checkMarkdownLinks(pluginRoot, "README.md");
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/resolves outside the plugin root/u);
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
	it("validates the repository's real plugin with no issues", () => {
		stubCiOff();
		const report = checkAgentPlugin({
			pluginRoot: realPluginRoot,
			repoRoot,
			versionFromReleaseTrain: undefined,
		});
		expect(report.issues).toEqual([]);
	});

	it("rejects a newer manifest pin during PR validation", () => {
		stubCiEnvironment("pull_request");
		const report = checkAgentPlugin({
			pluginRoot: realPluginRoot,
			repoRoot,
			versionFromReleaseTrain: "0.0.0-alpha.1",
		});
		expect(
			report.issues.some((issue) =>
				/is newer than the release train/u.test(issue.message),
			),
		).toBe(true);
		expect(
			report.notes.some((note) => note.includes("exactReleaseTrain=false")),
		).toBe(false);
	});

	it("notes the event name and commit ish when the comparison runs without the exact pin", () => {
		stubCiEnvironment("push");
		const train = parsePluginManifest(
			readFileSync(path.join(realPluginRoot, "plugin.json"), "utf8"),
		).value?.version;
		const report = checkAgentPlugin({
			pluginRoot: realPluginRoot,
			repoRoot,
			versionFromReleaseTrain: train,
		});
		expect(report.issues).toEqual([]);
		expect(
			report.notes.some(
				(note) =>
					note.includes("exactReleaseTrain=false") &&
					note.includes("GITHUB_EVENT_NAME=push") &&
					note.includes("commitIsh=HEAD"),
			),
		).toBe(true);
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
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		const messages = report.issues.map((issue) => issue.message).join("\n");
		expect(messages).toMatch(/description drifted/u);
		expect(messages).toMatch(/body drifted/u);
		expect(messages).toMatch(/contains a secret-shaped value/u);
		expect(messages).not.toContain(secret);
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
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		expect(
			report.issues.some((issue) =>
				/the portable set is exactly/.test(issue.message),
			),
		).toBe(true);
	});

	it("rejects plugin-only skill files that have no .agents/skills mirror", async () => {
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
		});
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
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
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
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
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
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
			const missing = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
			expect(
				missing.issues.some(
					(issue) =>
						issue.file === "bin/hobo-mcp.mjs" &&
						issue.message.includes("is missing in CI"),
				),
			).toBe(true);
			await writeFile(path.join(pluginRoot, "bin/hobo-mcp.mjs"), "tiny");
			const tiny = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
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
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		const bundleIssues = report.issues.filter(
			(issue) => issue.file === "bin/hobo-mcp.mjs",
		);
		expect(bundleIssues).toHaveLength(1);
		expect(bundleIssues[0]?.message).toContain("secret-shaped value");
		expect(bundleIssues[0]?.message).not.toContain(secret);
	});

	it("accepts a matching bundle attestation in a GitHub Actions job", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
		const bundleBody = "y".repeat(1024 * 1024);
		const sha256 = createHash("sha256").update(bundleBody).digest("hex");
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
			".bundle-attestation.json": `${JSON.stringify({
				sha256,
				runId: "run-current",
				commitSha: "commit-current",
			})}\n`,
		});
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		const attestationIssues = report.issues.filter(
			(issue) =>
				issue.file === "bin/hobo-mcp.mjs" ||
				issue.file === ".bundle-attestation.json",
		);
		expect(
			attestationIssues.filter((issue) =>
				/attestation|bundle attestation/u.test(issue.message),
			),
		).toEqual([]);
	});

	it("rejects a bundle attestation minted for a different workflow run in CI", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
		const bundleBody = "x".repeat(1024 * 1024);
		const sha256 = createHash("sha256").update(bundleBody).digest("hex");
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
			".bundle-attestation.json": `${JSON.stringify({
				sha256,
				runId: "run-other",
				commitSha: "commit-current",
			})}\n`,
		});
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		expect(
			report.issues.some((issue) =>
				/runId does not match this workflow run/u.test(issue.message),
			),
		).toBe(true);
	});

	it("rejects a bundle attestation whose commitSha does not match GITHUB_SHA", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
		const bundleBody = "x".repeat(1024 * 1024);
		const sha256 = createHash("sha256").update(bundleBody).digest("hex");
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
			".bundle-attestation.json": `${JSON.stringify({
				sha256,
				runId: "run-current",
				commitSha: "commit-other",
			})}\n`,
		});
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		expect(
			report.issues.some((issue) =>
				/commitSha does not match this workflow checkout/u.test(issue.message),
			),
		).toBe(true);
	});

	it("rejects a bundle attestation whose sha256 does not match the bundle bytes", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
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
			".bundle-attestation.json": `${JSON.stringify({
				sha256: "0".repeat(64),
				runId: "run-current",
				commitSha: "commit-current",
			})}\n`,
		});
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		expect(
			report.issues.some((issue) =>
				/sha256 does not match bin\/hobo-mcp.mjs/u.test(issue.message),
			),
		).toBe(true);
	});

	it("rejects a bundle attestation missing runAttempt when GITHUB_RUN_ATTEMPT is set", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
		vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
		const bundleBody = "x".repeat(1024 * 1024);
		const sha256 = createHash("sha256").update(bundleBody).digest("hex");
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
			".bundle-attestation.json": `${JSON.stringify({
				sha256,
				runId: "run-current",
				commitSha: "commit-current",
			})}\n`,
		});
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		expect(
			report.issues.some((issue) =>
				/runAttempt does not match this workflow attempt/u.test(issue.message),
			),
		).toBe(true);
	});

	it("rejects a present bundle without attestation in CI", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", "run-current");
		vi.stubEnv("GITHUB_SHA", "commit-current");
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
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		expect(
			report.issues.some((issue) =>
				/without a bundle attestation/u.test(issue.message),
			),
		).toBe(true);
		vi.unstubAllEnvs();
	});

	it("rejects attestation when GITHUB_RUN_ID is unset in CI", async () => {
		vi.stubEnv("CI", "1");
		vi.stubEnv("GITHUB_ACTIONS", "true");
		vi.stubEnv("GITHUB_RUN_ID", undefined);
		vi.stubEnv("GITHUB_SHA", "commit-current");
		const bundleBody = "x".repeat(1024 * 1024);
		const sha256 = createHash("sha256").update(bundleBody).digest("hex");
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
			".bundle-attestation.json": `${JSON.stringify({
				sha256,
				runId: "run-current",
				commitSha: "commit-current",
			})}\n`,
		});
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		expect(
			report.issues.some((issue) => /GITHUB_RUN_ID/u.test(issue.message)),
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
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
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
		await mkdir(schemaDir, { recursive: true });
		await writeFile(
			path.join(schemaDir, "MANIFEST.sha256"),
			`${"a".repeat(64)}  plugin.schema.json\n`,
		);
		await writeFile(
			path.join(schemaDir, "plugin.schema.json"),
			`{"$id":"${"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"}"}\n`,
		);
		await writeFile(
			path.join(schemaDir, "mcp.schema.json"),
			`{"$id":"${"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"}"}\n`,
		);
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
		expect(
			report.issues.some((issue) => issue.message.includes("MANIFEST.sha256")),
		).toBe(true);
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
		const referenceMarkdown = (
			await readFile(
				path.join(
					realPluginRoot,
					"skills/hobo-setup/references/agent-tooling.md",
				),
				"utf8",
			)
		).replace("(repo-only: it lives in the HoBo repository)", "(repo only)");
		const issues = agentToolingReferenceDriftIssues({
			docsMarkdown,
			referenceMarkdown,
		});
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/drifted from docs\/agent-tooling\.md/u);
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
		const report = checkAgentPlugin({ pluginRoot, repoRoot: scratchRepo });
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
		const cleanReport = checkAgentPlugin({
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
		const report = checkAgentPlugin({
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

	it("resolves the PR branch tip (HEAD^2) for pull_request and merge_group checkouts", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		stubCiEnvironment("pull_request");
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
		stubCiEnvironment("merge_group");
		expect(versionPinCommitIsh(repoRoot)).toBe(prHead);
	});

	it("requires exact pins for PR events and commits resolved from HEAD^2", async () => {
		const { repoRoot, prHead } = await scratchMergeRepo();
		stubCiEnvironment("pull_request");
		expect(requiresExactReleaseTrainVersion(repoRoot, "HEAD")).toBe(true);
		stubCiEnvironment("push");
		expect(requiresExactReleaseTrainVersion(repoRoot, prHead)).toBe(true);
		expect(requiresExactReleaseTrainVersion(repoRoot, "HEAD")).toBe(false);
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
			).toThrow("nbgv unavailable");
			vi.stubEnv(variable, undefined);
		}
	});
});
