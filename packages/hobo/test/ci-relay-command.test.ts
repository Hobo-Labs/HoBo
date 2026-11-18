import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createHoboCli } from "@hobo/cli";
import { describe, expect, it, vi } from "vitest";
import { createCiCommand } from "../src/ci-command.js";

const cwd = resolve(import.meta.dirname, "../../ci-vercel");
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd,
	encoding: "utf8",
}).trim();

describe("HoBo relay delivery command", () => {
	it("defaults to a pinned preview delivered by HoBo CD", () => {
		const program = `
			import {createHoboCli} from "./packages/cli/src/index.ts";
			import {createCiCommand} from "./packages/hobo/src/ci-command.ts";
			let calls = 0;
			const cli = createHoboCli({commands: {ci: createCiCommand({env: {}, fetch: async () => {calls++; throw new Error("unexpected");}})}});
			const result = await cli.run(["ci", "deploy", "--ref", "main", "--sha", process.env.FIXTURE_SHA, "--wait", "--dry-run", "--json"], {cwd: process.env.FIXTURE_RELAY_DIR});
			const response = JSON.parse(result.stdout);
			process.stdout.write(JSON.stringify({exitCode: result.exitCode, code: response.code, preview: response.message?.includes("as a preview"), calls}));
		`;
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", program],
			{
				cwd: resolve(cwd, "../.."),
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, FIXTURE_SHA: sha, FIXTURE_RELAY_DIR: cwd },
			},
		);
		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({
			exitCode: 0,
			code: "HOBO_CI_MANAGED_PLANNED",
			preview: true,
			calls: 0,
		});
	}, 90_000);

	it("refuses legacy options before provider I/O without echoing their values", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new Error("unexpected network request");
		});
		const cli = createHoboCli({
			commands: { ci: createCiCommand({ env: {}, fetch }) },
		});
		for (const extra of [
			["--team", "fixture-private-team"],
			["--set", "A=fixture-private-value"],
			["--provision"],
			["--adopt"],
		]) {
			const result = await cli.run(
				["ci", "deploy", "--ref", "main", "--sha", sha, ...extra, "--json"],
				{ cwd },
			);
			expect(result.exitCode).toBe(2);
			expect(result.stdout).not.toContain("fixture-private");
			expect(result.stdout).toMatch(/HoBo.*(?:setup|managed)/u);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("requires a pinned source before provider I/O", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new Error("unexpected network request");
		});
		const cli = createHoboCli({
			commands: { ci: createCiCommand({ env: {}, fetch }) },
		});
		const result = await cli.run(["ci", "deploy", "--ref", "main", "--json"], {
			cwd,
		});
		expect(JSON.parse(result.stdout).code).toBe(
			"HOBO_CI_MANAGED_SOURCE_INVALID",
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
