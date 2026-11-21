import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("build-agent-plugin CI posture", { timeout: 300_000 }, () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("refuses a bundle when CI is active without GITHUB_ACTIONS", () => {
		const build = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/build-agent-plugin.mts"],
			{
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 300_000,
				env: {
					...process.env,
					CI: "1",
					GITHUB_ACTIONS: "",
					TF_BUILD: "",
				},
			},
		);
		expect(build.status).not.toBe(0);
		const combined = `${build.stdout}\n${build.stderr}`;
		expect(combined).toMatch(
			/refuse to ship a bundle without attestation|GITHUB_ACTIONS/u,
		);
	});

	it("refuses GitHub Actions attestation without a run attempt", () => {
		const build = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/build-agent-plugin.mts"],
			{
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 300_000,
				env: {
					...process.env,
					CI: "1",
					GITHUB_ACTIONS: "true",
					GITHUB_RUN_ID: "run-current",
					GITHUB_RUN_ATTEMPT: "",
					GITHUB_SHA: "commit-current",
				},
			},
		);
		expect(build.status).not.toBe(0);
		expect(`${build.stdout}\n${build.stderr}`).toMatch(
			/GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, and GITHUB_SHA are required/u,
		);
	});
});
