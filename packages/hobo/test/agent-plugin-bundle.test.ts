import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BitwardenClient as ShimmedBitwardenClient } from "../../../plugins/hobo/src/bitwarden-sdk-napi.mts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const bundle = path.join(repoRoot, "plugins/hobo/bin/hobo-mcp.mjs");

const Message = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	result: z.record(z.string(), z.json()).optional(),
});

const started: { kill(): boolean }[] = [];
afterEach(() => {
	for (const child of started.splice(0)) child.kill();
});

function ensureBundle(): void {
	if (existsSync(bundle)) return;
	const buildEnv = { ...process.env, HOBO_AGENT_PLUGIN_LOCAL_BUILD: "1" };
	for (const key of [
		"CI",
		"GITHUB_ACTIONS",
		"GITHUB_EVENT_NAME",
		"GITHUB_REF",
		"GITHUB_REPOSITORY",
		"GITHUB_RUN_ID",
		"GITHUB_RUN_ATTEMPT",
		"GITHUB_SHA",
		"GITHUB_SERVER_URL",
		"GITHUB_JOB",
		"ACTIONS_ID_TOKEN_REQUEST_URL",
		"ACTIONS_ID_TOKEN_REQUEST_TOKEN",
		"TF_BUILD",
		"TEAMCITY_VERSION",
		"GITLAB_CI",
		"CIRCLECI",
		"BUILDKITE",
		"CODEBUILD_BUILD_ID",
	]) {
		delete buildEnv[key];
	}
	const build = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/build-agent-plugin.mts"],
		{
			cwd: repoRoot,
			encoding: "utf8",
			env: buildEnv,
			timeout: 300_000,
		},
	);
	if (build.status !== 0 || !existsSync(bundle)) {
		throw new Error(
			`The agent-plugin bundle could not be built (exit ${build.status}): ${build.stdout}\n${build.stderr}`,
		);
	}
}

describe("agent plugin bundle", { timeout: 300_000 }, () => {
	it("serves MCP from plugins/hobo/bin/hobo-mcp.mjs", async () => {
		ensureBundle();
		const stateDir = mkdtempSync(path.join(tmpdir(), "hobo-plugin-bundle-"));
		const child = spawn(process.execPath, [bundle], {
			cwd: path.dirname(bundle),
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH ?? "",
				HOBO_HOME: stateDir,
				XDG_CONFIG_HOME: path.join(stateDir, "config"),
				XDG_STATE_HOME: path.join(stateDir, "state"),
				XDG_CACHE_HOME: path.join(stateDir, "cache"),
				TMPDIR: stateDir,
			},
		});
		started.push(child);
		child.stdin.on("error", () => {});
		child.stderr.resume();
		const seen: z.infer<typeof Message>[] = [];
		const waiters: (() => void)[] = [];
		createInterface({ input: child.stdout }).on("line", (line) => {
			seen.push(Message.parse(JSON.parse(line)));
			for (const wake of waiters.splice(0)) wake();
		});
		const closed = new Promise<number | null>((resolve, reject) => {
			child.once("close", resolve);
			child.once("error", () =>
				reject(new Error("The bundled MCP server could not start.")),
			);
		});
		const closedFailure = closed.then((code) => {
			throw new Error(`The bundled MCP server exited with status ${code}.`);
		});
		void closedFailure.catch(() => {});
		const answerTo = async (id: number) => {
			for (;;) {
				const found = seen.find((message) => message.id === id);
				if (found !== undefined) return found;
				await Promise.race([
					new Promise<void>((resolve) => waiters.push(resolve)),
					closedFailure,
				]);
			}
		};
		try {
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } })}\n`,
			);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
			);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
			);
			expect((await answerTo(1)).result).toMatchObject({
				serverInfo: { name: "hobo-mcp" },
			});
			const tools = z
				.object({ tools: z.array(z.object({ name: z.string() })) })
				.parse((await answerTo(2)).result);
			expect(tools.tools.map((tool) => tool.name)).toContain("capture_secret");
			child.stdin.end();
			expect(await closed).toBe(0);
		} finally {
			child.kill();
			await closed.catch(() => undefined);
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("proxies the Bitwarden secrets() surface after the lazy native load", () => {
		const server = {
			apiUrl: "https://api.bitwarden.com",
			identityUrl: "https://identity.bitwarden.com",
			userAgent: "hobo-agent-plugin-bundle-test",
		};
		const afterAuth = new ShimmedBitwardenClient(server);
		expect(afterAuth.auth()).toEqual(
			expect.objectContaining({ loginAccessToken: expect.any(Function) }),
		);
		expect(afterAuth.secrets()).toEqual(
			expect.objectContaining({
				list: expect.any(Function),
				get: expect.any(Function),
				create: expect.any(Function),
				update: expect.any(Function),
			}),
		);
		const beforeAuth = new ShimmedBitwardenClient(server);
		expect(beforeAuth.secrets()).toEqual(
			expect.objectContaining({ list: expect.any(Function) }),
		);
	});

	it("detects secret-shaped values anywhere in a large plugin file", async () => {
		const { scanTextForSecrets } = await import(
			"../../../scripts/check-agent-plugin.ts"
		);
		const secret = ["sk", "-ant-", "api03-secret-shaped-boundary-value"].join("");
		const largeText = `${"x".repeat(1024 * 1024)}\n${secret}\n${"y".repeat(1024 * 1024)}`;
		expect(
			scanTextForSecrets("large.txt", largeText).map((issue) => issue.message),
		).toContain("contains a secret-shaped value; never commit credentials");
		expect(scanTextForSecrets("clean.txt", "ordinary plugin text")).toEqual([]);
	});
});
