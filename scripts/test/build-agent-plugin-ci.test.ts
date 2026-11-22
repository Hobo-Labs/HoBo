import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
	agentPluginBuildAttestationIssue,
	agentPluginBuildIsNonPublishing,
} from "../build-agent-plugin.mts";

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

	it("admits only trusted main publication, main verification, or identity-checked non-publishing builds", () => {
		const head = "a".repeat(40);
		const trustedMain = {
			...githubRun,
			GITHUB_EVENT_NAME: "push",
			GITHUB_REF: "refs/heads/main",
		};
		expect(agentPluginBuildAttestationIssue(githubRun, head)).toMatch(
			/trusted main ref/u,
		);
		expect(
			agentPluginBuildAttestationIssue(
				{
					...trustedMain,
					GITHUB_JOB: "agent-plugin-provenance",
					ACTIONS_ID_TOKEN_REQUEST_URL:
						"https://token.actions.githubusercontent.com/.well-known/openid-configuration",
					ACTIONS_ID_TOKEN_REQUEST_TOKEN:
						"request-capability.request-capability.request-capability",
				},
				head,
			),
		).toBeUndefined();
		expect(
			agentPluginBuildAttestationIssue(
				{ ...trustedMain, GITHUB_JOB: "main-gate" },
				head,
			),
		).toBeUndefined();
		expect(
			agentPluginBuildAttestationIssue(
				{ ...trustedMain, GITHUB_JOB: "agent-plugin-provenance" },
				head,
			),
		).toMatch(/OIDC capability/u);
		for (const oidc of [
			{
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://evil.example/oidc",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN:
					"request-capability.request-capability.request-capability",
			},
			{
				ACTIONS_ID_TOKEN_REQUEST_URL:
					"https://token.actions.githubusercontent.com.evil/oidc",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN:
					"request-capability.request-capability.request-capability",
			},
			{
				ACTIONS_ID_TOKEN_REQUEST_URL:
					"https://token.actions.githubusercontent.com/oidc",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "short",
			},
		]) {
			expect(
				agentPluginBuildAttestationIssue(
					{
						...trustedMain,
						GITHUB_JOB: "agent-plugin-provenance",
						...oidc,
					},
					head,
				),
			).toMatch(/OIDC capability/u);
		}
		const pullRequest = {
			...githubRun,
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_REF: "refs/pull/2913/merge",
		};
		const mergeGroup = {
			...githubRun,
			GITHUB_EVENT_NAME: "merge_group",
			GITHUB_REF: `refs/heads/gh-readonly-queue/main/pr-2913-${head}`,
		};
		for (const build of [pullRequest, mergeGroup]) {
			expect(agentPluginBuildIsNonPublishing(build)).toBe(true);
			expect(agentPluginBuildAttestationIssue(build, head)).toBeUndefined();
			expect(agentPluginBuildAttestationIssue(build, undefined)).toMatch(
				/could not resolve the checked-out HEAD commit/u,
			);
			expect(agentPluginBuildAttestationIssue(build, "unparseable")).toMatch(
				/could not resolve the checked-out HEAD commit/u,
			);
			expect(agentPluginBuildAttestationIssue(build, "b".repeat(40))).toMatch(
				/does not match the checked-out commit/u,
			);
			for (const changes of [
				{ GITHUB_REPOSITORY: "attacker/fork" },
				{ GITHUB_SERVER_URL: "https://github.com.evil" },
				{ GITHUB_REF: "refs/heads/main" },
			]) {
				expect(
					agentPluginBuildAttestationIssue({ ...build, ...changes }, head),
				).toMatch(/non-publishing PR bundle builds require/u);
			}
		}
		expect(
			agentPluginBuildAttestationIssue(
				{ ...mergeGroup, GITHUB_REF: pullRequest.GITHUB_REF },
				head,
			),
		).toMatch(/non-publishing PR bundle builds require/u);
		expect(
			agentPluginBuildAttestationIssue(
				{ ...pullRequest, GITHUB_REF: mergeGroup.GITHUB_REF },
				head,
			),
		).toMatch(/non-publishing PR bundle builds require/u);
		expect(
			agentPluginBuildAttestationIssue(
				{
					...trustedMain,
					GITHUB_REF: "refs/heads/feature",
					GITHUB_JOB: "main-gate",
				},
				head,
			),
		).toMatch(/trusted main ref/u);
	});

	it("refuses unguarded builds outside recognized CI", () => {
		expect(agentPluginBuildAttestationIssue({}, undefined)).toMatch(
			/HOBO_AGENT_PLUGIN_LOCAL_BUILD=1/u,
		);
		expect(
			agentPluginBuildAttestationIssue(
				{ HOBO_AGENT_PLUGIN_LOCAL_BUILD: "1" },
				undefined,
			),
		).toBeUndefined();
		expect(
			agentPluginBuildAttestationIssue(
				{ HOBO_AGENT_PLUGIN_LOCAL_BUILD: "1", CI: "1" },
				undefined,
			),
		).toMatch(/GitHub Actions/u);
	});

	it("does not treat custom environment switches as attestation evidence", () => {
		expect(
			agentPluginBuildAttestationIssue(
				{
					CI: "1",
					GITHUB_ACTIONS: "true",
					HOBO_AGENT_PLUGIN_ATTESTED_EXTERNALLY: "1",
				},
				undefined,
			),
		).toMatch(/trusted main ref/u);
		expect(
			agentPluginBuildAttestationIssue(
				{
					...githubRun,
					GITHUB_EVENT_NAME: "push",
					GITHUB_REF: "refs/heads/main",
					HOBO_AGENT_PLUGIN_VERIFY: "1",
					GH_TOKEN: "verification-token",
				},
				"a".repeat(40),
			),
		).toMatch(/main-gate verification job/u);
	});

	it("fails closed for CI signals that are not GitHub Actions", () => {
		for (const env of [
			{ TEAMCITY_VERSION: "2024.1" },
			{ GITLAB_CI: "true" },
			{ CIRCLECI: "true" },
			{ BUILDKITE: "true" },
			{ CODEBUILD_BUILD_ID: "codebuild:1" },
		]) {
			expect(agentPluginBuildAttestationIssue(env, undefined)).toMatch(
				/GitHub Actions|trusted CI|explicitly local build/u,
			);
		}
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

	it("hashes run identity into every test task", () => {
		const turbo = z
			.object({
				globalPassThroughEnv: z.array(z.string()),
				tasks: z.object({
					test: z.object({ env: z.array(z.string()).optional() }),
				}),
			})
			.parse(
				JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8")),
			);
		for (const name of ["GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID"]) {
			expect(turbo.globalPassThroughEnv).not.toContain(name);
			expect(turbo.tasks.test.env ?? []).toContain(name);
		}
	});
});
