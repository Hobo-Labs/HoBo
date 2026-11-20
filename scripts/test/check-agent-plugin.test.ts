import { spawnSync } from "node:child_process";
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
	manifestSemanticIssues,
	mcpSemanticIssues,
	parseFrontmatterBlock,
	parseMcpConfig,
	parsePluginManifest,
	releaseTrainSemverForPluginCheck,
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

	it("accepts a pin ahead of the train, as it is after a squash-merge to main", () => {
		expect(
			manifestSemanticIssues(
				{ ...validManifest, version: "0.0.0-alpha.500" },
				"0.0.0-alpha.400",
			),
		).toEqual([]);
		expect(
			manifestSemanticIssues(
				{ ...validManifest, version: "0.1.0" },
				"0.0.0-alpha.400",
			),
		).toEqual([]);
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
		expect(
			scanTextForSecrets("x.json", "bearer sk-abcdefghijklmnopqrst").length,
		).toBe(1);
		expect(
			scanTextForSecrets("x.json", "github_token: ghp_abcdefghijklmnopqrst")
				.length,
		).toBe(1);
	});

	it("accepts the word token in prose without a value", () => {
		expect(
			scanTextForSecrets("x.md", "the token the owner holds stays private"),
		).toEqual([]);
	});
});

describe("checkPluginScopedPath", () => {
	it("allows absolute and plugin-rooted paths, blocks traversal", () => {
		expect(checkPluginScopedPath("", "${PLUGIN_ROOT}/bin/x.mjs")).toEqual([]);
		expect(checkPluginScopedPath("", "/usr/bin/env")).toEqual([]);
		expect(checkPluginScopedPath("", "${PLUGIN_ROOT}/../x.mjs")).toHaveLength(
			1,
		);
		expect(checkPluginScopedPath("", "./skills/../..")).toHaveLength(1);
		expect(checkPluginScopedPath("", "../outside.mjs")).toHaveLength(1);
		expect(checkPluginScopedPath("", "foo/../../outside")).toHaveLength(1);
		expect(checkPluginScopedPath("", "..\\outside.mjs")).toHaveLength(1);
		expect(checkPluginScopedPath("", "foo\\..\\outside")).toHaveLength(1);
		expect(
			checkPluginScopedPath("", "${PLUGIN_ROOT}\\..\\outside.mjs"),
		).toHaveLength(1);
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
		const report = checkAgentPlugin({
			pluginRoot: realPluginRoot,
			repoRoot,
			versionFromReleaseTrain: undefined,
		});
		expect(report.issues).toEqual([]);
	});

	it("fails when a shipped skill drifts from its repo source", async () => {
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
			"skills/hobo-setup/SKILL.md":
				"---\nname: hobo-setup\ndescription: drifted\n---\n\nchanged body\n",
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
	it("prefers GITHUB_HEAD_SHA over the checked-out merge ref", async () => {
		const { repoRoot } = await scratchMergeRepo();
		const headSha = "b".repeat(40);
		stubCiEnvironment("merge_group", headSha);
		expect(versionPinCommitIsh(repoRoot)).toBe(headSha);
		stubCiEnvironment("pull_request", headSha);
		expect(versionPinCommitIsh(repoRoot)).toBe(headSha);
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
});
