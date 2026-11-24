import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createOneJobRunner,
	githubQueueJobSource,
	OneJobRunnerError,
	removeOneJobRunner,
	userGithub,
} from "../src/machine-worker/jobs.js";
import { githubOwner } from "../src/machine-worker/session.js";

type Interaction = Readonly<{
	description: string;
	providerStates: readonly { name: string }[];
	request: Readonly<{
		method: string;
		path: string;
		query?: string;
		headers: Readonly<Record<string, string>>;
		body?: object;
	}>;
	response: Readonly<{ status: number; body?: object }>;
}>;

const pact: { interactions: readonly Interaction[] } = JSON.parse(
	readFileSync(
		new URL("./github-machine-worker.pact.json", import.meta.url),
		"utf8",
	),
);

const API = "https://api.github.com";
const TOKEN = "gho_pact_fixture";
const QUEUED =
	"octo/app is private, run 7 has job 70 queued for hobo-machine-m-7f3a, and the signed-in user is its admin";
const FORK =
	"octo/app is private, and run 8 is a pull request from a fork whose job 80 is queued for hobo-machine-m-7f3a";
const LABEL = "hobo-machine-m-7f3a";

function provider(state: string, used: Set<string>): typeof fetch {
	return async (input, init) => {
		const url = new URL(String(input));
		expect(url.origin).toBe(API);
		const method = init?.method ?? "GET";
		const query = url.search.replace(/^\?/u, "") || undefined;
		const entry = pact.interactions.find(
			(each) =>
				each.providerStates.some((given) => given.name === state) &&
				each.request.method === method &&
				each.request.path === url.pathname &&
				each.request.query === query,
		);
		if (!entry)
			throw new Error(`unmatched ${method} ${url.pathname}${url.search}`);
		const headers = new Headers(init?.headers);
		for (const [name, value] of Object.entries(entry.request.headers))
			expect(headers.get(name)).toBe(value);
		expect(init?.redirect).toBe("error");
		if (entry.request.body === undefined) expect(init?.body ?? null).toBeNull();
		else expect(JSON.parse(String(init?.body))).toEqual(entry.request.body);
		used.add(entry.description);
		return entry.response.body === undefined
			? new Response(null, { status: entry.response.status })
			: Response.json(entry.response.body, { status: entry.response.status });
	};
}

function github(state: string, used: Set<string>) {
	return userGithub({ fetch: provider(state, used), token: TOKEN });
}

describe("GitHub machine worker pact", () => {
	it("executes every interaction through the machine worker's client", async () => {
		const used = new Set<string>();
		const queued = github(QUEUED, used);
		expect(await githubOwner(queued)).toEqual({
			ownerId: "42",
			ownerLogin: "octocat",
		});
		expect(
			await githubOwner(github("the token is revoked", used)),
		).toBeUndefined();

		const offers = await githubQueueJobSource({
			github: queued,
			repositories: ["octo/app"],
			label: LABEL,
		}).take(4, 0);
		expect(offers).toEqual([
			{
				jobId: 70,
				runId: 7,
				repository: "octo/app",
				labels: [LABEL],
				private: true,
				fork: false,
			},
		]);
		const forked = await githubQueueJobSource({
			github: github(FORK, used),
			repositories: ["octo/app"],
			label: LABEL,
		}).take(4, 0);
		expect(forked.map((offer) => [offer.jobId, offer.fork])).toEqual([
			[80, true],
		]);

		const request = {
			repository: "octo/app",
			name: "hobo-machine-m-7f3a-70",
			labels: [LABEL],
		};
		const runner = await createOneJobRunner(queued, request);
		expect(runner).toEqual({
			id: 99,
			name: "hobo-machine-m-7f3a-70",
			repository: "octo/app",
			encodedJitConfig: "eyJydW5uZXIiOiJmaXh0dXJlIn0=",
		});
		const refusal = await createOneJobRunner(
			github("the signed-in user is not an admin of octo/app", used),
			request,
		).catch((error: Error) => error);
		expect(refusal).toBeInstanceOf(OneJobRunnerError);
		expect(refusal.message).toMatch(/admin rights/u);
		expect(refusal.message).not.toContain(TOKEN);

		expect(
			await removeOneJobRunner(
				github("the one-job runner 99 on octo/app is still registered", used),
				runner,
			),
		).toBe(true);
		expect(
			await removeOneJobRunner(
				github(
					"GitHub already removed the one-job runner 99 after its job",
					used,
				),
				runner,
			),
		).toBe(false);

		expect([...used].sort()).toEqual(
			pact.interactions.map((each) => each.description).sort(),
		);
	});
});
