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

	it("registers the same HoBo owner-handoff server for each supported agent", () => {
		const mcpConfig = z.object({
			mcpServers: z.object({
				hobo: z.object({ command: z.string(), args: z.array(z.string()) }),
			}),
		});
		const launch =
			'root=$(git rev-parse --show-toplevel) || exit 1; cd "$root" || exit 1; exec node --import tsx packages/hobo/src/bin/hobo-mcp.ts';
		const expected = { command: "bash", args: ["-c", launch] };
		for (const file of [".mcp.json", ".cursor/mcp.json"]) {
			const config = mcpConfig.parse(
				JSON.parse(readFileSync(path.join(root, file), "utf8")),
			);
			expect(config.mcpServers.hobo).toEqual(expected);
		}
		const codex = readFileSync(path.join(root, ".codex/config.toml"), "utf8");
		const hobo =
			/\[mcp_servers\.hobo\]([\s\S]*?)(?=\n\[|$)/u.exec(codex)?.[1] ?? "";
		expect(hobo).toContain('command = "bash"');
		expect(hobo).toContain(`args = ["-c", '${launch}']`);
		expect(hobo).toContain("startup_timeout_sec = 30");
		expect(hobo).toContain("tool_timeout_sec = 1800");
	});

	it("starts the HoBo launcher from a worktree path containing spaces", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "hobo worktree "));
		try {
			const env = gitEnvironment({
				...process.env,
				GIT_DIR: path.join(directory, "unrelated.git"),
				GIT_WORK_TREE: path.join(directory, "unrelated"),
				GIT_INDEX_FILE: path.join(directory, "unrelated-index"),
			});
			const nested = path.join(directory, "nested");
			const bin = path.join(directory, "bin");
			mkdirSync(nested);
			mkdirSync(bin);
			const initialized = spawnSync("git", ["init", "-q", directory], {
				encoding: "utf8",
				env,
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
				.parse(JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")));
			const launched = spawnSync(
				config.mcpServers.hobo.command,
				config.mcpServers.hobo.args,
				{
					cwd: nested,
					encoding: "utf8",
					env: { ...env, PATH: `${bin}:${env.PATH ?? ""}` },
				},
			);
			expect(launched.status, launched.stderr).toBe(0);
			expect(launched.stdout.trim().split("\n")).toEqual([
				directory,
				"--import",
				"tsx",
				"packages/hobo/src/bin/hobo-mcp.ts",
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
