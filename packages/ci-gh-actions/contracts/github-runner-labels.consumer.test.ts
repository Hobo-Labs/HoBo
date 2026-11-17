import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	adoptionLabel,
	adoptRunner,
	listAdoptableRunners,
	type RunnerAdoptionGithub,
	releaseRunner,
	runnerAdopter,
} from "../src/runner-adoption.js";

type Interaction = {
	description: string;
	providerStates: { name: string }[];
	request: {
		method: string;
		path: string;
		query?: string;
		body?: { labels: string[] };
	};
	response: { status: number; body: object };
};

// SAFETY: test-only hand-authored Pact; every body is parsed by the module under test.
const pact = JSON.parse(
	readFileSync(
		new URL("./github-runner-labels.pact.json", import.meta.url),
		"utf8",
	),
) as { interactions: Interaction[] };

const NONE_ADOPTED =
	"octo/app is private in the organization octo, and no runner is adopted";
const ADOPTED = "runner 11 of octo/app and runner 21 of octo are adopted";

/** Answers only what the pact holds for `state`, and records what was used. */
function pactGithub(state: string, used: Set<string>): RunnerAdoptionGithub {
	return {
		async request(method, path, body) {
			const [pathname, query] = path.split("?");
			const entry = pact.interactions.find(
				(each) =>
					each.providerStates[0]?.name === state &&
					each.request.method === method &&
					each.request.path === pathname &&
					each.request.query === query,
			);
			if (!entry) throw new Error(`unmatched ${method} ${path} in ${state}`);
			expect(body).toEqual(entry.request.body);
			used.add(entry.description);
			return Response.json(entry.response.body, {
				status: entry.response.status,
			});
		},
	};
}

describe("GitHub self-hosted runner labels pact", () => {
	it("derives the labels the pact was written with", () => {
		expect(adoptionLabel("repository", "octo/app", 11)).toBe(
			"hobo-runner-f4c4d042",
		);
		expect(adoptionLabel("organization", "octo", 21)).toBe(
			"hobo-runner-3e66ccd3",
		);
	});

	it("executes every interaction", async () => {
		const used = new Set<string>();
		const before = pactGithub(NONE_ADOPTED, used);
		const adopter = await runnerAdopter(before);
		expect(adopter).toEqual({ id: "42", login: "octocat" });
		const listing = await listAdoptableRunners(before, "octo/app");
		expect(listing.runners.map((runner) => runner.id)).toEqual([11, 21]);
		expect(listing.leftOut.map((runner) => runner.id)).toEqual([22]);
		const input = {
			repository: "octo/app",
			accountId: "acct-1",
			adopter,
			sharing: undefined,
			nowMs: 1_793_016_000_000,
		};
		const repoRunner = await adoptRunner(before, { ...input, runnerId: 11 });
		expect(repoRunner.advert.runsOn).toBe("hobo-runner-f4c4d042");
		const orgRunner = await adoptRunner(before, { ...input, runnerId: 21 });
		expect(orgRunner.advert).toMatchObject({
			runsOn: "hobo-runner-3e66ccd3",
			os: "macos",
			arch: "arm64",
			isolation: "host",
			slots: 1,
		});

		const after = pactGithub(ADOPTED, used);
		expect(
			(await releaseRunner(after, { repository: "octo/app", runnerId: 11 }))
				.removed,
		).toEqual(["hobo-runner-f4c4d042"]);
		expect(
			(await releaseRunner(after, { repository: "octo/app", runnerId: 21 }))
				.removed,
		).toEqual(["hobo-runner-3e66ccd3"]);

		expect([...used].sort()).toEqual(
			pact.interactions.map((each) => each.description).sort(),
		);
	});
});
