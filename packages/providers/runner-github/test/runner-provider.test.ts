import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	createGithubActionsClient,
	createGithubRunnerProvider,
	GITHUB_API_VERSION,
	GITHUB_CREDENTIALS_MISSING,
	GithubApiError,
	type GithubFetch,
	ownerTokenProvider,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/runner-github-boundary.pact.json"),
		"utf8",
	),
);

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

// A mocked transport replaying the recorded GitHub responses: dispatch 204,
// newest run listing, then run polling queued -> completed.
function mockTransport(overrides: { conclusion?: string } = {}) {
	const requests: RecordedRequest[] = [];
	const runBody = {
		id: 4242,
		status: "completed",
		conclusion: overrides.conclusion ?? "success",
		html_url: "https://github.com/hobo-dev/hobo-jobs/actions/runs/4242",
	};
	const transport: GithubFetch = async (url, init) => {
		requests.push({
			url,
			method: init.method,
			headers: init.headers,
			...(init.body === undefined ? undefined : { body: init.body }),
		});
		if (url.includes("/dispatches")) {
			return {
				ok: true,
				status: 204,
				text: async () => "",
				json: async () => ({}),
			};
		}
		if (url.includes("/runs?event=workflow_dispatch")) {
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ workflow_runs: [runBody] }),
			};
		}
		if (url.includes("/actions/runs/4242")) {
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => runBody,
			};
		}
		return {
			ok: false,
			status: 404,
			text: async () => "not found",
			json: async () => ({}),
		};
	};
	return { transport, requests };
}

function client(transport: GithubFetch) {
	return createGithubActionsClient({
		owner: "hobo-dev",
		repo: "hobo-jobs",
		token: async () => "ghs_short_lived_installation_token",
		fetch: transport,
	});
}

describe("GitHub Actions RunnerProvider (hobo:runner, replay lane)", () => {
	it("run(job) forms the pact-recorded workflow_dispatch and tracks the run to a succeeded result", async () => {
		const { transport, requests } = mockTransport();
		const provider = createGithubRunnerProvider({
			client: client(transport),
			tracking: { wait: async () => {}, intervalMs: 0 },
		});

		const result = await provider.run({
			jobId: "job-1",
			command: "pnpm test",
		});

		const dispatch = requests[0];
		assert.ok(dispatch);
		const recorded = pact.interactions[0];
		assert.ok(dispatch.url.endsWith(recorded.request.path));
		assert.equal(dispatch.method, recorded.request.method);
		assert.equal(dispatch.headers["x-github-api-version"], GITHUB_API_VERSION);
		assert.equal(dispatch.headers.accept, "application/vnd.github+json");
		assert.deepEqual(JSON.parse(dispatch.body ?? "{}"), recorded.request.body);

		assert.equal(result.status, "succeeded");
		assert.equal(result.runId, pact.interactions[1].response.body.id);
		assert.equal(result.runUrl, pact.interactions[1].response.body.html_url);
		assert.deepEqual(
			result.events.map((event) => event.type),
			["runner.JobStarted", "runner.JobSucceeded"],
		);
	});

	it("maps a failed conclusion to a failed result with a runner.JobFailed fact", async () => {
		const { transport } = mockTransport({ conclusion: "failure" });
		const provider = createGithubRunnerProvider({
			client: client(transport),
			tracking: { wait: async () => {}, intervalMs: 0 },
		});

		const result = await provider.run({ jobId: "job-2" });
		assert.equal(result.status, "failed");
		assert.equal(result.events[1]?.type, "runner.JobFailed");
	});

	it("gates on missing brokered credentials with the typed failure (no limping into 401s)", async () => {
		const { transport } = mockTransport();
		const gated = createGithubActionsClient({
			owner: "hobo-dev",
			repo: "hobo-jobs",
			token: ownerTokenProvider({
				resolve: async () => {
					throw new Error("not in the store");
				},
			}),
			fetch: transport,
		});
		const provider = createGithubRunnerProvider({
			client: gated,
			tracking: { wait: async () => {}, intervalMs: 0 },
		});

		await assert.rejects(
			provider.run({ jobId: "job-3" }),
			(error: { code?: string }) => error.code === GITHUB_CREDENTIALS_MISSING,
		);
	});

	it("surfaces non-2xx GitHub responses as typed GithubApiError", async () => {
		const failing: GithubFetch = async () => ({
			ok: false,
			status: 422,
			text: async () => "workflow does not have workflow_dispatch trigger",
			json: async () => ({}),
		});
		const provider = createGithubRunnerProvider({
			client: client(failing),
			tracking: { wait: async () => {}, intervalMs: 0 },
		});

		await assert.rejects(
			provider.run({ jobId: "job-4" }),
			(error: Error) => error instanceof GithubApiError && error.status === 422,
		);
	});
});
