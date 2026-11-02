import { defineCiPolicy } from "@hobo/ci";
import { toJsonString } from "@bufbuild/protobuf";
import { DesiredCiPolicySchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import {
	defineCiProjectConfig,
	parseCiProjectConfig,
} from "../src/project-config.js";
import {
	assertRelayOriginAllowed,
	inferJobAdmission,
	isForkPullRequestRun,
	mergeCiProjectLocalOverlay,
	parseCiProjectSelection,
	resolveCiConfigRefForRun,
	resolveCiRelayRoute,
	type CiWebhookRoutingContext,
} from "../src/relay-routing.js";
import { selectCiEnvironment } from "../src/project-config.js";

const basePolicy = () =>
	JSON.parse(
		toJsonString(DesiredCiPolicySchema, defineCiPolicy({
			accountId: "ci",
			tenantId: "ci",
			pool: { label: "hobo", os: "linux", architecture: "x64" },
			providers: [
				{
					id: "gh",
					kind: "github",
					connectionRef: "gh",
					runsOn: "ubuntu-24.04",
				},
			],
			budget: {
				scope: "ci-account",
				currency: "USD",
				period: "manual",
				timeZone: "UTC",
				limitMicros: 1_000_000,
			},
			routing: {
				strategy: "lowest-total-incremental-cost",
				noEligibleProvider: "queue",
				unknownAllocation: "zero",
			},
			thresholds: [],
		})),
	);

function projectDocument() {
	return {
		defaultEnvironment: "ci",
		selection: {
		rules: [
			{ environment: "ci", match: { branch: "main" } },
			{ environment: "production", match: { refPrefix: "refs/tags/" } },
		],
			forkPullRequestEnvironment: "ci",
		},
		environments: {
			local: {
				relayOrigin: "http://127.0.0.1:8787",
				allowInsecureLoopback: true,
				jobAdmission: "pull",
				policy: basePolicy(),
			},
			ci: {
				relayOrigin: "https://ci.example.test",
				policy: basePolicy(),
			},
			production: {
				relayOrigin: "https://prod.example.test",
				policy: basePolicy(),
			},
		},
	};
}

describe("relay routing from repository CI config", () => {
	it("uses base-branch config ref for fork pull requests", () => {
		const run = {
			id: 1,
			run_attempt: 1,
			event: "pull_request",
			head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			head_branch: "feature",
			path: "x",
			display_title: "x",
			status: "queued",
			conclusion: null,
			run_started_at: null,
			updated_at: "2026-01-01T00:00:00Z",
			actor: { id: 1 },
			repository: { id: 100, private: true },
			head_repository: { id: 200 },
			pull_requests: [{ base: { ref: "main", repo: { id: 100 } } }],
		};
		expect(isForkPullRequestRun(run, 100)).toBe(true);
		expect(resolveCiConfigRefForRun(run, 100)).toBe("main");
	});

	it("routes fork pull requests to the configured safe environment", () => {
		const config = defineCiProjectConfig(projectDocument());
		const selection = parseCiProjectSelection(projectDocument());
		const context: CiWebhookRoutingContext = {
			repositoryFullName: "acme/demo",
			repositoryId: 100,
			installationId: 1,
			workflowRunId: 9,
			eventName: "pull_request",
			headBranch: "feature",
			headRef: "refs/heads/feature",
			isForkPullRequest: true,
			configRef: "main",
		};
		const route = resolveCiRelayRoute({ config, selection, context });
		expect(route.environment.name).toBe("ci");
		expect(route.relayOrigin).toBe("https://ci.example.test");
		expect(route.admission).toBe("push");
		assertRelayOriginAllowed(route, config);
		expect(() =>
			assertRelayOriginAllowed(
				{ ...route, relayOrigin: "https://evil.example.test" },
				config,
			),
		).toThrow(/not allowed/);
	});

	it("infers pull admission when local environment is selected explicitly", () => {
		const config = defineCiProjectConfig(projectDocument());
		const local = selectCiEnvironment(config, "local");
		expect(local.relayOrigin).toBe("http://127.0.0.1:8787");
		expect(inferJobAdmission(local, local.jobAdmission)).toBe("pull");
	});

	it("merges gitignored local overlay environments", () => {
		const committed = JSON.stringify({
			defaultEnvironment: "ci",
			environments: {
				ci: {
					relayOrigin: "https://ci.example.test",
					policy: basePolicy(),
				},
			},
		});
		const local = JSON.stringify({
			environments: {
				ci: {
					relayOrigin: "http://127.0.0.1:8787",
					allowInsecureLoopback: true,
					jobAdmission: "pull",
				},
			},
		});
		const config = parseCiProjectConfig(
			mergeCiProjectLocalOverlay(committed, local),
		);
		expect(config.environments.ci?.relayOrigin).toBe("http://127.0.0.1:8787");
		expect(config.environments.ci?.jobAdmission).toBe("pull");
	});
});
