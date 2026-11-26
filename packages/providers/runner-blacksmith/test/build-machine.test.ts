import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CREDIT_EXHAUSTED,
	createGithubActionsClient,
	type GithubFetch,
} from "@hobo/runner-github";
import { describe, it } from "vitest";

import {
	BLACKSMITH_CACHE_LANE,
	BUILD_CACHE_LANE_OBSERVED,
	type CacheLaneFact,
	createBlacksmithBuildMachineProvider,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/runner-blacksmith-boundary.pact.json"),
		"utf8",
	),
);
const RECORDED = pact.interactions[2].response.body;

function mockTransport() {
	const urls: string[] = [];
	const runBody = {
		id: 9,
		status: "completed",
		conclusion: "success",
		html_url: "https://github.com/hobo-dev/hobo-jobs/actions/runs/9",
	};
	const transport: GithubFetch = async (url) => {
		urls.push(url);
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
		if (url.includes("/packages/container/")) {
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => [{ name: RECORDED.image.digest }],
			};
		}
		return {
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => runBody,
		};
	};
	return { transport, urls };
}

function machine(
	transport: GithubFetch,
	options: {
		creditBudget?: { remainingUnits: number };
		onFact?: (fact: CacheLaneFact) => void;
	} = {},
) {
	return createBlacksmithBuildMachineProvider({
		client: createGithubActionsClient({
			owner: "hobo-dev",
			repo: "hobo-jobs",
			token: async () => "ghs_short_lived_installation_token",
			fetch: transport,
		}),
		owner: "hobo-dev",
		...options,
		tracking: { wait: async () => {}, intervalMs: 0 },
	});
}

describe("Blacksmith BuildMachineProvider (hobo:build-machine, replay lane)", () => {
	it("executes an accelerated build and surfaces the pact-recorded cache-lane fact with the ImageRef", async () => {
		const { transport } = mockTransport();
		const facts: CacheLaneFact[] = [];
		const provider = machine(transport, { onFact: (fact) => facts.push(fact) });

		const image = await provider.execute({
			buildId: "checkout-api",
			estimatedUnits: 3,
		});

		assert.equal(image.digest, RECORDED.image.digest);
		assert.equal(image.mediaType, RECORDED.image.mediaType);
		assert.equal(facts.length, 1);
		const fact = facts[0];
		assert.ok(fact);
		assert.equal(fact.type, BUILD_CACHE_LANE_OBSERVED);
		assert.equal(fact.type, RECORDED.fact.type);
		assert.equal(fact.cacheLane, BLACKSMITH_CACHE_LANE);
		assert.equal(fact.cacheLane, RECORDED.fact.cacheLane);
		assert.equal(fact.source, "declared-provider");
		assert.equal(fact.runId, 9);
	});

	it("throws the typed credit.exhausted failure BEFORE any dispatch when over budget", async () => {
		const { transport, urls } = mockTransport();
		const provider = machine(transport, {
			creditBudget: { remainingUnits: 1 },
		});

		await assert.rejects(
			provider.execute({ buildId: "big-build", estimatedUnits: 5 }),
			(error: { code?: string; providerId?: string }) =>
				error.code === CREDIT_EXHAUSTED &&
				error.providerId === "@hobo/runner-blacksmith",
		);
		assert.equal(urls.length, 0);
	});

	it("refuses to fabricate an ImageRef (and emits no cache fact) when the build run failed", async () => {
		const failedRun = {
			id: 10,
			status: "completed",
			conclusion: "failure",
			html_url: "",
		};
		const transport: GithubFetch = async (url) => {
			if (url.includes("/dispatches")) {
				return {
					ok: true,
					status: 204,
					text: async () => "",
					json: async () => ({}),
				};
			}
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ workflow_runs: [failedRun] }),
			};
		};
		const facts: CacheLaneFact[] = [];
		const provider = machine(transport, { onFact: (fact) => facts.push(fact) });

		await assert.rejects(
			provider.execute({ buildId: "broken" }),
			/concluded failure/,
		);
		assert.equal(facts.length, 0);
	});
});
