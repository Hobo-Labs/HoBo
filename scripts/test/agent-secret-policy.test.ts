import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as z from "zod";

import {
	type HookEvent,
	respond,
	secretPolicyRefusal,
} from "../agent-secret-policy.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hook = join(root, "scripts/agent-secret-policy.mts");
const words = (...parts: string[]) => parts.join(" ");

function run(format: string, event: HookEvent) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", hook, `--format=${format}`],
		{ cwd: root, input: JSON.stringify(event), encoding: "utf8" },
	);
}

describe("agent secret policy hook", () => {
	it("refuses commands that store secrets or variables", () => {
		for (const command of [
			words("gh", "secret", "set", "NPM_TOKEN"),
			words("gh", "secret", "delete", "NPM_TOKEN"),
			words("gh", "variable", "set", "TURBO_TEAM"),
			words("gh", "variable", "delete", "TURBO_TEAM"),
			words("vercel", "env", "add", "TOKEN"),
			words("vercel", "env", "rm", "TOKEN"),
			words("echo", "A=1", ">", ".env"),
			words("export", "NPM_TOKEN=x"),
		])
			assert.match(
				secretPolicyRefusal({ tool_name: "Bash", tool_input: { command } }) ??
					"",
				/choose_secret_store/u,
				command,
			);
		assert.equal(
			secretPolicyRefusal({
				tool_name: "Bash",
				tool_input: { command: "git status" },
			}),
			undefined,
		);
	});

	it("refuses a person's GitHub sign-in token", () => {
		for (const command of [
			words("gh", "auth", "token"),
			words("echo", "x", "|", "gh", "auth", "login", "--with-token"),
		])
			assert.match(
				secretPolicyRefusal({ tool_name: "Bash", tool_input: { command } }) ??
					"",
				/GitHub App/u,
				command,
			);
	});

	it("refuses edits to secret files and credential-storing tools", () => {
		for (const event of [
			{ tool_name: "Write", tool_input: { file_path: "/repo/.env" } },
			{ tool_name: "Edit", tool_input: { file_path: "apps/web/.env.local" } },
			{ tool_name: "Write", tool_input: { file_path: "certs\\tls.key" } },
			{
				tool_name: "apply_patch",
				tool_input: {
					command:
						"*** Begin Patch\n*** Add File: .env.production\n+A=1\n*** End Patch",
				},
			},
			{
				tool_name: "mcp__claude-code-remote__request_credential",
				tool_input: {},
			},
			{ tool_name: "mcp__Vercel__create_project_env", tool_input: {} },
		])
			assert.ok(secretPolicyRefusal(event), JSON.stringify(event));
		assert.equal(
			secretPolicyRefusal({
				tool_name: "Write",
				tool_input: { file_path: "src/env.ts" },
			}),
			undefined,
		);
		assert.equal(
			secretPolicyRefusal({
				tool_name: "mcp__hobo__choose_secret_store",
				tool_input: {},
			}),
			undefined,
		);
	});

	it("speaks each harness's refusal protocol", () => {
		const command = words("gh", "secret", "set", "NPM_TOKEN");
		const claude = run("claude", {
			tool_name: "Bash",
			tool_input: { command },
		});
		assert.equal(claude.status, 2);
		assert.match(claude.stderr, /owner store session/u);
		assert.equal(
			run("codex", { tool_name: "Bash", tool_input: { command } }).status,
			2,
		);
		const cursor = run("cursor", { command, cwd: root });
		assert.equal(cursor.status, 2);
		assert.equal(
			z
				.object({ permission: z.literal("deny") })
				.loose()
				.parse(JSON.parse(cursor.stdout)).permission,
			"deny",
		);
		const copilot = run("copilot", {
			toolName: "bash",
			toolArgs: JSON.stringify({ command }),
		});
		assert.equal(copilot.status, 0);
		assert.equal(
			z
				.object({ permissionDecision: z.literal("deny") })
				.loose()
				.parse(JSON.parse(copilot.stdout)).permissionDecision,
			"deny",
		);
		const allowed = run("copilot", {
			toolName: "bash",
			toolArgs: '{"command":"ls"}',
		});
		assert.deepEqual([allowed.status, allowed.stdout], [0, ""]);
		assert.deepEqual(respond("claude", undefined), {
			stdout: "",
			stderr: "",
			exitCode: 0,
		});
	});

	it("is configured before tool use for each repository agent harness", () => {
		const schema = z
			.object({ hooks: z.record(z.string(), z.unknown()) })
			.loose();
		for (const [file, events] of [
			[".claude/settings.json", ["PreToolUse"]],
			[".codex/hooks.json", ["PreToolUse"]],
			[
				".cursor/hooks.json",
				["preToolUse", "beforeShellExecution", "beforeMCPExecution"],
			],
			[".github/hooks/secret-policy.json", ["preToolUse"]],
		] as const) {
			const config = schema.parse(
				JSON.parse(readFileSync(join(root, file), "utf8")),
			);
			for (const event of events)
				assert.match(
					JSON.stringify(config.hooks[event]),
					/scripts\/agent-secret-policy\.mts/u,
					`${file} ${event}`,
				);
		}
		const settings = z
			.object({ permissions: z.object({ deny: z.array(z.string()) }) })
			.loose()
			.parse(
				JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")),
			);
		assert.ok(
			settings.permissions.deny.includes(
				"mcp__claude-code-remote__request_credential",
			),
		);
	});
});
