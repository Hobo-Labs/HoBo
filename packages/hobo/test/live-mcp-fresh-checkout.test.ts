import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

function onPath(command: string): boolean {
	try {
		execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const McpConfig = z.object({
	mcpServers: z.object({ hobo: z.record(z.string(), z.json()) }),
});
const Init = z.object({
	type: z.literal("system"),
	subtype: z.literal("init"),
	mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })),
	tools: z.array(z.string()),
});

async function initFromClaudeCode(
	cwd: string,
	mcpConfig: string,
	env: NodeJS.ProcessEnv,
): Promise<z.infer<typeof Init>> {
	const child = spawn(
		"claude",
		[
			"-p",
			"reply ok",
			"--mcp-config",
			mcpConfig,
			"--strict-mcp-config",
			"--output-format",
			"stream-json",
			"--verbose",
			"--max-turns",
			"1",
		],
		{ cwd, env, stdio: ["ignore", "pipe", "ignore"] },
	);
	try {
		for await (const line of createInterface({ input: child.stdout })) {
			const parsed = Init.safeParse(JSON.parse(line));
			if (parsed.success) return parsed.data;
		}
		throw new Error("Claude Code ended without an init event.");
	} finally {
		child.kill();
	}
}

describe.skipIf(!onPath("claude") || !onPath("pnpm"))(
	"LIVE Claude Code loads HoBo's MCP tools from a fresh, unbuilt checkout",
	{ timeout: 900_000 },
	() => {
		it("lists the owner-ceremony tools with no prior build and an empty turbo cache", async () => {
			const scratch = mkdtempSync(path.join(tmpdir(), "hobo-mcp-fresh-"));
			const checkout = path.join(scratch, "checkout");
			execFileSync(
				"git",
				["-C", REPO, "worktree", "add", "--detach", checkout, "HEAD"],
				{
					stdio: "ignore",
				},
			);
			try {
				execFileSync(
					"pnpm",
					["install", "--frozen-lockfile", "--prefer-offline"],
					{
						cwd: checkout,
						stdio: "ignore",
					},
				);
				const config = McpConfig.parse(
					JSON.parse(readFileSync(path.join(checkout, ".mcp.json"), "utf8")),
				);
				const mcpConfig = path.join(scratch, "hobo-only.json");
				writeFileSync(
					mcpConfig,
					JSON.stringify({ mcpServers: { hobo: config.mcpServers.hobo } }),
				);
				const env: NodeJS.ProcessEnv = {
					...process.env,
					TURBO_CACHE_DIR: mkdtempSync(path.join(scratch, "turbo-cache-")),
				};
				delete env.MCP_TIMEOUT;

				const init = await initFromClaudeCode(checkout, mcpConfig, env);

				expect(init.mcp_servers).toContainEqual({
					name: "hobo",
					status: "connected",
				});
				expect(init.tools).toEqual(
					expect.arrayContaining([
						"mcp__hobo__choose_secret_store",
						"mcp__hobo__cd",
						"mcp__hobo__ci",
						"mcp__hobo__capture_secret",
					]),
				);
			} finally {
				execFileSync(
					"git",
					["-C", REPO, "worktree", "remove", "--force", checkout],
					{
						stdio: "ignore",
					},
				);
				rmSync(scratch, { recursive: true, force: true });
			}
		});
	},
);
