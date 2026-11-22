/**
 * AX guard: `pnpm run doctor` must surface agent-tooling readiness offline
 * (AUTH, setup --help, MCP launchers) without live cloud credentials.
 */
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { gitEnvironment } from "../scripts/lib/pins-git-core.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("doctor agent-tooling (AX)", () => {
	// Spawns the full doctor preflight; slow on cold CI runners (>5s default).
	it("reports AUTH, setup help, and fail-closed MCP launchers", {
		timeout: 120_000,
	}, () => {
		const r = spawnSync(
			"node",
			["--experimental-strip-types", "scripts/dx-preflight.mts", "doctor"],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 60_000,
				env: gitEnvironment(),
			},
		);
		const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
		expect(r.status, out).toBe(0);
		expect(out).toMatch(/AUTH\.md present/);
		expect(out).toMatch(/WorkOS auth\.md|auth\.md protocol/i);
		expect(out).toMatch(/setup-agent-tools\.sh --help/);
		expect(out).toMatch(/agent-mcp-serena\.sh present/);
		expect(out).toMatch(/agent-mcp-headroom\.sh present/);
		expect(out).toMatch(/agent-mcp-gbrain\.sh present/);
		// Zero-key path: missing gbrain must still print a copy-pasteable next step
		if (/gbrain not on PATH/.test(out)) {
			expect(out).toMatch(/setup-agent-tools\.sh --common-only --no-gbrain/);
			expect(out).toMatch(/AUTH\.md/);
		}
	});

	it("allows slow local MCP servers to initialize", () => {
		const config = readFileSync(path.join(root, ".codex/config.toml"), "utf8");
		expect(config.match(/startup_timeout_sec = 30/g)).toHaveLength(4);
	});

	it("registers the HoBo server for each supported agent", () => {
		const schema = z.object({
			mcpServers: z.object({
				hobo: z.object({ command: z.string(), args: z.array(z.string()) }),
			}),
		});
		const cursor = schema.parse(
			JSON.parse(readFileSync(path.join(root, ".cursor/mcp.json"), "utf8")),
		);
		expect(cursor.mcpServers.hobo.command).toBe("bash");
		expect(cursor.mcpServers.hobo.args[0]).toBe("-c");
		const launch = cursor.mcpServers.hobo.args[1];
		expect(launch).toContain("packages/hobo/src/bin/hobo-mcp.ts");
		const claude = schema.parse(
			JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")),
		);
		expect(claude.mcpServers.hobo).toEqual({
			command: "node",
			args: ["--import", "tsx", "packages/hobo/src/bin/hobo-mcp.ts"],
		});
		const codex = readFileSync(path.join(root, ".codex/config.toml"), "utf8");
		const hobo =
			/\[mcp_servers\.hobo\]([\s\S]*?)(?=\n\[|$)/u.exec(codex)?.[1] ?? "";
		expect(hobo).toContain('command = "bash"');
		expect(hobo).toContain(`args = ["-c", '${launch}']`);
		expect(hobo).toContain("startup_timeout_sec = 30");
		expect(hobo).toContain("tool_timeout_sec = 1800");
	});

	it("starts the HoBo launcher from a nested worktree with inherited Git variables", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "hobo worktree "));
		try {
			const cleanEnv = gitEnvironment({ ...process.env });
			const nested = path.join(directory, "nested");
			const bin = path.join(directory, "bin");
			mkdirSync(nested);
			mkdirSync(bin);
			const initialized = spawnSync("git", ["init", "-q", directory], {
				encoding: "utf8",
				env: cleanEnv,
			});
			expect(initialized.status, initialized.stderr).toBe(0);
			writeFileSync(
				path.join(bin, "node"),
				'#!/bin/sh\npwd -P\nprintf "%s\\n" "$@"\n',
				{ mode: 0o755 },
			);
			const config = z
				.object({
					mcpServers: z.object({
						hobo: z.object({ command: z.string(), args: z.array(z.string()) }),
					}),
				})
				.parse(
					JSON.parse(readFileSync(path.join(root, ".cursor/mcp.json"), "utf8")),
				);
			const launched = spawnSync(
				config.mcpServers.hobo.command,
				config.mcpServers.hobo.args,
				{
					cwd: nested,
					encoding: "utf8",
					env: {
						...cleanEnv,
						PATH: `${bin}:${cleanEnv.PATH ?? ""}`,
						GIT_DIR: path.join(directory, "unrelated.git"),
						GIT_WORK_TREE: path.join(directory, "unrelated"),
						GIT_INDEX_FILE: path.join(directory, "unrelated-index"),
					},
				},
			);
			expect(launched.status, launched.stderr).toBe(0);
			expect(launched.stdout.trim().split("\n")).toEqual([
				directory,
				"--import",
				"tsx",
				"packages/hobo/src/bin/hobo-mcp.ts",
			]);
			const inner = path.join(nested, "independent");
			mkdirSync(inner);
			const innerInit = spawnSync("git", ["init", "-q", inner], {
				encoding: "utf8",
				env: cleanEnv,
			});
			expect(innerInit.status, innerInit.stderr).toBe(0);
			const refused = spawnSync(
				config.mcpServers.hobo.command,
				config.mcpServers.hobo.args,
				{
					cwd: inner,
					encoding: "utf8",
					env: {
						...cleanEnv,
						PATH: `${bin}:${cleanEnv.PATH ?? ""}`,
						GIT_CEILING_DIRECTORIES: directory,
					},
				},
			);
			expect(refused.status).not.toBe(0);
			expect(refused.stdout).toBe("");
			expect(refused.stderr).toContain("nested Git checkout");
			const gitConfig = path.join(directory, "safe-git-config");
			writeFileSync(gitConfig, `[safe]\n\tdirectory = ${inner}\n`);
			const unsafeParent = spawnSync(
				config.mcpServers.hobo.command,
				config.mcpServers.hobo.args,
				{
					cwd: inner,
					encoding: "utf8",
					env: {
						...cleanEnv,
						PATH: `${bin}:${cleanEnv.PATH ?? ""}`,
						GIT_CONFIG_GLOBAL: gitConfig,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
					},
				},
			);
			expect(unsafeParent.status).not.toBe(0);
			expect(unsafeParent.stdout).toBe("");
			expect(unsafeParent.stderr).toContain("nested Git checkout");
			const placeholder = mkdtempSync(path.join(tmpdir(), "hobo placeholder "));
			try {
				mkdirSync(path.join(placeholder, ".git"));
				const checkout = path.join(placeholder, "checkout");
				mkdirSync(checkout);
				const initializedCheckout = spawnSync("git", ["init", "-q", checkout], {
					encoding: "utf8",
					env: cleanEnv,
				});
				expect(initializedCheckout.status, initializedCheckout.stderr).toBe(0);
				const allowed = spawnSync(
					config.mcpServers.hobo.command,
					config.mcpServers.hobo.args,
					{
						cwd: checkout,
						encoding: "utf8",
						env: { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH ?? ""}` },
					},
				);
				expect(allowed.status, allowed.stderr).toBe(0);
				expect(allowed.stdout.split("\n")[0]).toBe(checkout);
			} finally {
				rmSync(placeholder, { recursive: true, force: true });
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
