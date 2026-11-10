import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createHoboCli } from "../src/shell/dispatch.js";
import { UsageError } from "../src/shell/errors.js";
import { parseArgv } from "../src/shell/parse.js";
import { projectScopedVerbs } from "../src/shell/verbs.js";

describe("CI shell routing", () => {
	it("preserves literal search text after -- and accepts --cwd=PATH", () => {
		const parsed = parseArgv(["ci", "--cwd=.", "grep", "--", "--help"]);
		expect(parsed.args).toEqual(["grep", "--", "--help"]);
		expect(parsed.help).toBe(false);
		expect(parsed.cwd).toBe(path.resolve("."));
	});
	it("preserves CI options for the command's strict parser", () => {
		const options = [
			"connect",
			"--repo",
			"owner/repository",
			"--relay=https://ci.hobo.test",
			"--token-file",
			"./account-token",
			"--installation-id",
			"123",
			"--accept-all-matching-jobs",
			"-y",
		];
		const parsed = parseArgv(["ci", ...options, "--json", "--verbose"]);
		expect(parsed.args).toEqual(options);
		expect(parsed.flags.json).toBe(true);
		expect(parsed.flags.verbose).toBe(true);
	});

	it("keeps help and working directory at the shell boundary", () => {
		const parsed = parseArgv(["ci", "connect", "--cwd", ".", "-h", "-q"]);
		expect(parsed.args).toEqual(["connect"]);
		expect(parsed.cwd).toBe(path.resolve("."));
		expect(parsed.help).toBe(true);
		expect(parsed.flags.quiet).toBe(true);
	});

	it("does not allow CI flags to change other verbs", () => {
		expect(() => parseArgv(["up", "--repo", "owner/repository"])).toThrow(
			UsageError,
		);
		expect(() => parseArgv(["--yes", "ci", "connect"])).toThrow(UsageError);
	});

	it("supports Vercel-style JSON format aliases only for CI", () => {
		for (const format of [
			["--format", "json"],
			["-F", "json"],
			["--format=json"],
		]) {
			const parsed = parseArgv(["ci", "list", ...format]);
			expect(parsed.flags.json).toBe(true);
			expect(parsed.args).toEqual(["list"]);
		}
		for (const format of [["--format", "yaml"], ["--format=xml"], ["-F"]]) {
			expect(() => parseArgv(["ci", "list", ...format])).toThrow(UsageError);
		}
		expect(() => parseArgv(["up", "--format", "json"])).toThrow(UsageError);
	});

	it("dispatches without requiring a Bindle project", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "hobo-ci-shell-"));
		try {
			const cli = createHoboCli({
				commands: {
					ci: {
						run: async ({ args, context }) => ({
							message: "CI handler reached",
							data: { args, projectDir: context.projectDir },
						}),
					},
				},
			});
			const result = await cli.run(["ci", "list", "--json"], { cwd });
			expect(projectScopedVerbs.has("ci")).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				verb: "ci",
				data: { args: ["list"], projectDir: null },
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("advertises connection setup in root and command help", async () => {
		const cli = createHoboCli();
		const root = await cli.run(["--help"]);
		expect(root.stdout).toContain("Connect a repository and inspect CI runs");
		for (const args of [
			["ci", "--help"],
			["ci", "connect", "-h"],
		]) {
			const help = await cli.run(args);
			expect(help.exitCode).toBe(0);
			expect(help.stdout).toContain("hobo ci connect");
			expect(help.stdout).toContain("hobo ci enable");
			expect(help.stdout).toContain("hobo ci github import-key");
			expect(help.stdout).toContain("hobo ci github key-status");
			expect(help.stdout).toContain("hobo ci deploy");
			expect(help.stdout).toContain("--target preview|production");
			expect(help.stdout).not.toContain("hobo ci github-key");
			expect(help.stdout).toContain("--accept-all-matching-jobs");
			for (const command of [
				"list|ls",
				"inspect",
				"logs",
				"grep",
				"rerun",
				"status",
			]) {
				expect(help.stdout).toContain(`hobo ci ${command}`);
			}
		}
	});
});
