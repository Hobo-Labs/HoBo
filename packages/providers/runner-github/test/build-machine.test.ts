import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	CREDIT_EXHAUSTED,
	createGithubActionsClient,
	createGithubBuildMachineProvider,
	type GithubFetch,
	OCI_IMAGE_MANIFEST_MEDIA_TYPE,
} from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/runner-github-boundary.pact.json"),
		"utf8",
	),
);
const RECORDED_DIGEST = pact.interactions[3].response.body[0].name;

function mockTransport() {
	const urls: string[] = [];
	const runBody = {
		id: 7,
		status: "completed",
		conclusion: "success",
		html_url: "https://github.com/hobo-dev/hobo-jobs/actions/runs/7",
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
				json: async () => [{ name: RECORDED_DIGEST }],
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
	creditBudget?: { remainingUnits: number },
) {
	return createGithubBuildMachineProvider({
		client: createGithubActionsClient({
			owner: "hobo-dev",
			repo: "hobo-jobs",
			token: async () => "ghs_short_lived_installation_token",
			fetch: transport,
		}),
		owner: "hobo-dev",
		...(creditBudget === undefined ? undefined : { creditBudget }),
		tracking: { wait: async () => {}, intervalMs: 0 },
	});
}

describe("GitHub BuildMachineProvider (hobo:build-machine, replay lane)", () => {
	it("execute(build) dispatches the build workflow and resolves the pact-recorded GHCR digest into a pullable ImageRef", async () => {
		const { transport, urls } = mockTransport();
		const provider = machine(transport);

		const image = await provider.execute({
			buildId: "checkout-api",
			estimatedUnits: 3,
		});

		assert.equal(image.digest, RECORDED_DIGEST);
		assert.equal(image.mediaType, OCI_IMAGE_MANIFEST_MEDIA_TYPE);
		assert.equal(
			image.uri,
			`oci://ghcr.io/hobo-dev/checkout-api@${RECORDED_DIGEST}`,
		);
		assert.ok(
			urls.some((url) =>
				url.includes(
					pact.interactions[3].request.path.replace("/versions", ""),
				),
			),
		);
	});

	it("throws the typed credit.exhausted failure BEFORE any dispatch when the budget cannot cover the build", async () => {
		const { transport, urls } = mockTransport();
		const provider = machine(transport, { remainingUnits: 2 });

		await assert.rejects(
			provider.execute({ buildId: "big-build", estimatedUnits: 5 }),
			(error: { code?: string; providerId?: string; buildId?: string }) =>
				error.code === CREDIT_EXHAUSTED &&
				error.providerId === "@hobo/runner-github" &&
				error.buildId === "big-build",
		);
		assert.equal(urls.length, 0);
	});

	it("debits the credit budget on success so a later over-budget build re-routes", async () => {
		const { transport } = mockTransport();
		const budget = { remainingUnits: 4 };
		const provider = machine(transport, budget);

		await provider.execute({ buildId: "checkout-api", estimatedUnits: 3 });
		assert.equal(budget.remainingUnits, 1);
		await assert.rejects(
			provider.execute({ buildId: "checkout-api", estimatedUnits: 3 }),
			(error: { code?: string }) => error.code === CREDIT_EXHAUSTED,
		);
	});

	it("refuses to fabricate an ImageRef when the build run did not succeed", async () => {
		const failedRun = {
			id: 8,
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
		const provider = machine(transport);

		await assert.rejects(
			provider.execute({ buildId: "broken" }),
			/concluded failure/,
		);
	});
});
