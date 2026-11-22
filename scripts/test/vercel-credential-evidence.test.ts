import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decide, relayInputDirs } from "../ci/relay-deploy-gate.mts";
import { inspectVercelCredentials } from "../ci/vercel-credential-evidence.mts";

const env = {
	GITHUB_ACTIONS: "true",
	GITHUB_EVENT_NAME: "workflow_dispatch",
	GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
	GITHUB_REPOSITORY_ID: "1274791462",
	GITHUB_REPOSITORY_OWNER_ID: "344805935",
	GITHUB_REF: "refs/heads/main",
	GITHUB_WORKFLOW_REF:
		"Hobo-Labs/HoBo/.github/workflows/vercel-credential-evidence.yml@refs/heads/main",
	GITHUB_SHA: "a".repeat(40),
};
const workflow = readFileSync(
	".github/workflows/vercel-credential-evidence.yml",
	"utf8",
);

describe("trusted-main Vercel credential evidence", () => {
	it("reports missing candidates without network calls or readiness claims", async () => {
		let calls = 0;
		const report = await inspectVercelCredentials({
			env,
			fetch: async () => {
				calls++;
				throw new Error("unexpected request");
			},
		});
		assert.deepEqual(report, {
			status: "observed",
			credentials: [
				{ name: "VERCEL_TOKEN", present: false, projectRead: "not-observed" },
				{
					name: "VERCEL_ACCESS_TOKEN",
					present: false,
					projectRead: "not-observed",
				},
			],
			ciCanDeploy: "not-evaluated",
			cdCanDeploy: "not-evaluated",
		});
		assert.equal(calls, 0);
	});
	it("uses the guarded SDK to read the exact project without exposing the candidate", async () => {
		const calls: Array<{
			url: string;
			method: string;
			redirect: RequestRedirect | undefined;
		}> = [];
		const result = await inspectVercelCredentials({
			env: { ...env, HOBO_VERCEL_TOKEN_CANDIDATE: "fake-provider-secret" },
			fetch: async (resource, init) => {
				calls.push({
					url: String(resource),
					method: init?.method ?? "GET",
					redirect: init?.redirect,
				});
				assert.equal(
					new Headers(init?.headers).get("authorization"),
					"Bearer fake-provider-secret",
				);
				return Response.json({
					id: "prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO",
					accountId: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
					name: "hobo-ci",
				});
			},
		});
		assert.deepEqual(result.credentials[0], {
			name: "VERCEL_TOKEN",
			present: true,
			projectRead: "verified",
		});
		assert.deepEqual(calls, [
			{
				url: "https://api.vercel.com/v9/projects/prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO?teamId=team_BRBUnG6uGhSsVV3EG5GFV3FM",
				method: "GET",
				redirect: "manual",
			},
		]);
		assert.equal(
			JSON.stringify(result).includes("fake-provider-secret"),
			false,
		);
		assert.equal(result.ciCanDeploy, "not-evaluated");
	});
	it("refuses forged run scope without reading candidates or calling providers", async () => {
		for (const change of [
			{ GITHUB_REF: "refs/heads/feature" },
			{ GITHUB_EVENT_NAME: "push" },
			{ GITHUB_REPOSITORY_ID: "other" },
			{ GITHUB_REPOSITORY_OWNER_ID: "other" },
			{
				GITHUB_WORKFLOW_REF:
					"Hobo-Labs/HoBo/.github/workflows/other.yml@refs/heads/main",
			},
		]) {
			let calls = 0;
			const result = await inspectVercelCredentials({
				env: { ...env, ...change, HOBO_VERCEL_TOKEN_CANDIDATE: "secret" },
				fetch: async () => {
					calls++;
					throw new Error("unexpected");
				},
			});
			assert.equal(result.status, "unavailable");
			assert.equal(calls, 0);
		}
	});
	it("checks each present candidate once even if another is denied", async () => {
		let calls = 0;
		const result = await inspectVercelCredentials({
			env: {
				...env,
				HOBO_VERCEL_TOKEN_CANDIDATE: "candidate-one",
				HOBO_VERCEL_ACCESS_TOKEN_CANDIDATE: "candidate-two",
			},
			fetch: async () => {
				calls++;
				return calls === 1
					? new Response("denied", { status: 403 })
					: Response.json({
							id: "prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO",
							accountId: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
							name: "hobo-ci",
						});
			},
		});
		assert.deepEqual(
			result.credentials.map((row) => row.projectRead),
			["unverified", "verified"],
		);
		assert.equal(calls, 2);
	});
	it("does not infer access from a foreign project, provider denial, redirect or malformed token", async () => {
		for (const response of [
			Response.json({
				id: "prj_other",
				accountId: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
				name: "hobo-ci",
			}),
			Response.json({
				id: "prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO",
				accountId: "team_other",
				name: "hobo-ci",
			}),
			new Response("fake-provider-secret", { status: 403 }),
			new Response("", {
				status: 302,
				headers: { location: "https://attacker.example/" },
			}),
		]) {
			let calls = 0;
			const result = await inspectVercelCredentials({
				env: { ...env, HOBO_VERCEL_TOKEN_CANDIDATE: "fake-provider-secret" },
				fetch: async () => {
					calls++;
					return response;
				},
			});
			assert.equal(result.credentials[0]?.projectRead, "unverified");
			assert.equal(calls, 1);
			assert.equal(
				JSON.stringify(result).includes("fake-provider-secret"),
				false,
			);
		}
		let calls = 0;
		const malformed = await inspectVercelCredentials({
			env: { ...env, HOBO_VERCEL_TOKEN_CANDIDATE: "bad\ntoken" },
			fetch: async () => {
				calls++;
				throw new Error("unexpected");
			},
		});
		assert.equal(malformed.credentials[0]?.projectRead, "unverified");
		assert.equal(calls, 0);
	});
	it("keeps the workflow pinned to main, read-only, bounded and relay-independent", () => {
		assert.match(workflow, /workflow_dispatch:/u);
		assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
		assert.match(workflow, /secrets\.VERCEL_TOKEN/u);
		assert.match(workflow, /secrets\.VERCEL_ACCESS_TOKEN/u);
		assert.match(workflow, /--ignore-scripts/u);
		assert.doesNotMatch(
			workflow,
			/\bcurl\b|hobo ci (?:up|deploy)|\/readyz|\/healthz/u,
		);
		assert.equal(
			decide({
				event: "push",
				store: "bound",
				inputDirs: relayInputDirs(readFileSync("pnpm-lock.yaml", "utf8")),
				changed: [
					".github/workflows/vercel-credential-evidence.yml",
					"scripts/ci/vercel-credential-evidence.mts",
					"scripts/test/vercel-credential-evidence.test.ts",
					"scripts/lint-actions.ts",
					"docs/ci/vercel-credential-evidence.md",
				],
			}).run,
			false,
		);
	});
});
