import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	bodyAfterFrontmatter,
	checkAgentPlugin,
	checkMarkdownLinks,
	checkPluginScopedPath,
	manifestSemanticIssues,
	mcpSemanticIssues,
	parseFrontmatterBlock,
	parseMcpConfig,
	parsePluginManifest,
	scanTextForSecrets,
} from "../check-agent-plugin.ts";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const realPluginRoot = path.join(repoRoot, "plugins/hobo");

const scratches: string[] = [];
afterEach(async () => {
	while (scratches.length > 0) {
		const dir = scratches.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

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
