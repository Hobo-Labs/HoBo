import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createGithubActionsClient,
	createGithubRunnerProvider,
	type GithubFetch,
	type RunnerJob,
} from "@hobo/runner-github";
import { describe, it } from "vitest";

import {
	BLACKSMITH_PROVIDER_ID,
	BLACKSMITH_RUNS_ON_DEFAULT,
	createBlacksmithRunnerProvider,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/runner-blacksmith-boundary.pact.json"),
		"utf8",
	),
);

interface RecordedRequest {
	url: string;
	method: string;
	body?: string;
}

function mockTransport() {
	const requests: RecordedRequest[] = [];
	const runBody = {
		id: 555,
		status: "completed",
		conclusion: "success",
		html_url: "https://github.com/hobo-dev/hobo-jobs/actions/runs/555",
	};
	const transport: GithubFetch = async (url, init) => {
		requests.push({
			url,
			method: init.method,
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
		return {
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => runBody,
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

describe("Blacksmith RunnerProvider (hobo:runner, replay lane)", () => {
	it("dispatches the pact-recorded workflow_dispatch with the runs-on substitution", async () => {
		const { transport, requests } = mockTransport();
		const provider = createBlacksmithRunnerProvider({
			client: client(transport),
			tracking: { wait: async () => {}, intervalMs: 0 },
		});

		const result = await provider.run({ jobId: "job-1", command: "pnpm test" });

		const dispatch = requests[0];
		assert.ok(dispatch);
		const recorded = pact.interactions[0];
		assert.ok(dispatch.url.endsWith(recorded.request.path));
		assert.deepEqual(JSON.parse(dispatch.body ?? "{}"), recorded.request.body);
		assert.equal(result.status, "succeeded");
		assert.equal(result.providerId, BLACKSMITH_PROVIDER_ID);
	});

	it("port-level substitutability: the SAME job spec runs unmodified on github and blacksmith", async () => {
		const job: RunnerJob = {
			jobId: "job-shared",
			command: "pnpm run conformance",
			estimatedUnits: 5,
		};

		const github = mockTransport();
		const blacksmith = mockTransport();
		const githubProvider = createGithubRunnerProvider({
			client: client(github.transport),
			tracking: { wait: async () => {}, intervalMs: 0 },
		});
		const blacksmithProvider = createBlacksmithRunnerProvider({
			client: client(blacksmith.transport),
			tracking: { wait: async () => {}, intervalMs: 0 },
		});

		const [githubResult, blacksmithResult] = await Promise.all([
			githubProvider.run(job),
			blacksmithProvider.run(job),
		]);

		// Same result/fact shape from the same job object; only provenance and
		// the runs-on substrate differ.
		assert.equal(githubResult.status, blacksmithResult.status);
		assert.equal(githubResult.jobId, blacksmithResult.jobId);
		assert.deepEqual(
			githubResult.events.map((event) => event.type),
			blacksmithResult.events.map((event) => event.type),
		);
		const blacksmithDispatch = JSON.parse(blacksmith.requests[0]?.body ?? "{}");
		assert.equal(blacksmithDispatch.inputs.runs_on, BLACKSMITH_RUNS_ON_DEFAULT);
		const githubDispatch = JSON.parse(github.requests[0]?.body ?? "{}");
		assert.equal("runs_on" in githubDispatch.inputs, false);
	});
});
