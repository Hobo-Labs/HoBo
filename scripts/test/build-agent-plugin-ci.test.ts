import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { agentPluginBuildAttestationIssue } from "../build-agent-plugin.mts";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("build-agent-plugin CI posture", { timeout: 300_000 }, () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const githubRun = {
		CI: "1",
		GITHUB_ACTIONS: "true",
		GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
		GITHUB_RUN_ID: "123",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_SHA: "a".repeat(40),
		GITHUB_SERVER_URL: "https://github.com",
	};

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
		expect(`${build.stdout}\n${build.stderr}`).toMatch(
			/CI bundle builds require/u,
		);
	});

	it("does not admit a CI build from GITHUB_ACTIONS alone", () => {
		expect(agentPluginBuildAttestationIssue(githubRun)).toMatch(
			/GITHUB_ACTIONS alone is insufficient/u,
		);
		expect(
			agentPluginBuildAttestationIssue({
				...githubRun,
				GITHUB_JOB: "agent-plugin-provenance",
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/oidc",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-capability",
			}),
		).toBeUndefined();
		expect(
			agentPluginBuildAttestationIssue({
				...githubRun,
				HOBO_AGENT_PLUGIN_VERIFY: "1",
				GH_TOKEN: "verification-token",
			}),
		).toBeUndefined();
		expect(
			agentPluginBuildAttestationIssue({
				CI: "1",
				GITHUB_ACTIONS: "true",
				HOBO_AGENT_PLUGIN_ATTESTED_EXTERNALLY: "1",
			}),
		).toBeUndefined();
	});

	it("does not request or persist an OIDC bearer token", () => {
		const source = readFileSync(
			path.join(repoRoot, "scripts/build-agent-plugin.mts"),
			"utf8",
		);
		expect(source).not.toContain("oidcToken");
		expect(source).not.toContain("requestGithubOidcToken");
		expect(source).not.toContain("fetch(");
	});

	it("scopes run identity to the test task instead of global Turbo env", () => {
		const turbo = z
			.object({
				globalPassThroughEnv: z.array(z.string()),
				tasks: z.object({
					test: z.object({ passThroughEnv: z.array(z.string()) }),
				}),
			})
			.parse(
				JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8")),
			);
		for (const name of ["GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID"]) {
			expect(turbo.globalPassThroughEnv).not.toContain(name);
			expect(turbo.tasks.test.passThroughEnv).toContain(name);
		}
	});
});
