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

	it("admits only trusted main publication, main verification, or non-publishing PR builds", () => {
		const trustedMain = {
			...githubRun,
			GITHUB_EVENT_NAME: "push",
			GITHUB_REF: "refs/heads/main",
		};
		expect(agentPluginBuildAttestationIssue(githubRun)).toMatch(
			/trusted main ref/u,
		);
		expect(
			agentPluginBuildAttestationIssue({
				...trustedMain,
				GITHUB_JOB: "agent-plugin-provenance",
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/oidc",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-capability",
			}),
		).toBeUndefined();
		expect(
			agentPluginBuildAttestationIssue({
				...trustedMain,
				GITHUB_JOB: "main-gate",
			}),
		).toBeUndefined();
		expect(
			agentPluginBuildAttestationIssue({
				...trustedMain,
				GITHUB_JOB: "agent-plugin-provenance",
			}),
		).toMatch(/OIDC capability/u);
		for (const eventName of ["pull_request", "merge_group"]) {
			expect(
				agentPluginBuildAttestationIssue({
					...githubRun,
					GITHUB_EVENT_NAME: eventName,
					GITHUB_REF: "refs/pull/2913/merge",
				}),
			).toBeUndefined();
		}
		expect(
			agentPluginBuildAttestationIssue({
				...trustedMain,
				GITHUB_REF: "refs/heads/feature",
				GITHUB_JOB: "main-gate",
			}),
		).toMatch(/trusted main ref/u);
	});

	it("does not treat custom environment switches as attestation evidence", () => {
		expect(
			agentPluginBuildAttestationIssue({
				CI: "1",
				GITHUB_ACTIONS: "true",
				HOBO_AGENT_PLUGIN_ATTESTED_EXTERNALLY: "1",
			}),
		).toMatch(/trusted main ref/u);
		expect(
			agentPluginBuildAttestationIssue({
				...githubRun,
				GITHUB_EVENT_NAME: "push",
				GITHUB_REF: "refs/heads/main",
				HOBO_AGENT_PLUGIN_VERIFY: "1",
				GH_TOKEN: "verification-token",
			}),
		).toMatch(/main-gate verification job/u);
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

	it("hashes run identity in the test task instead of passing it through", () => {
		const turbo = z
			.object({
				globalPassThroughEnv: z.array(z.string()),
				tasks: z.object({
					test: z.object({ env: z.array(z.string()) }),
				}),
			})
			.parse(
				JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8")),
			);
		for (const name of ["GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID"]) {
			expect(turbo.globalPassThroughEnv).not.toContain(name);
			expect(turbo.tasks.test.env).toContain(name);
		}
	});
});
