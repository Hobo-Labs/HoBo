import { readFileSync } from "node:fs";
import { testRouteRequest } from "@hobo/ci/runner-order/testing";
import { expect, it } from "vitest";
import { GithubRouteFacts } from "../src/relay-job/github-facts.js";

type Interaction = Readonly<{
	description: string;
	providerStates?: readonly { name: string }[];
	request: Readonly<{
		method: string;
		path: string;
		query?: Readonly<Record<string, readonly string[]>>;
		headers: Readonly<Record<string, string>>;
	}>;
	response: Readonly<{ status: number; body: object }>;
}>;

const pact: {
	metadata: {
		consumerFixtures: {
			repository: string;
			ownRunId: number;
			nowMilliseconds: number;
		};
	};
	interactions: readonly Interaction[];
} = JSON.parse(
	readFileSync(new URL("./relay-job-facts.pact.json", import.meta.url), "utf8"),
);
const API = "https://api.github.test";
const fixtures = pact.metadata.consumerFixtures;
const SLIP_LABELS = new Set(["hobo", "ubuntu-24.04"]);

function provider(state: string, matched: Set<string>): typeof fetch {
	const usable = pact.interactions.filter(
		(entry) =>
			!entry.providerStates ||
			entry.providerStates.some((given) => given.name === state),
	);
	return async (input, init) => {
		const url = new URL(String(input));
		const entry = usable.find((candidate) => {
			if (candidate.request.path !== url.pathname) return false;
			const query = Object.entries(candidate.request.query ?? {});
			return (
				query.length === [...url.searchParams.keys()].length &&
				query.every(([name, values]) =>
					values.every((value) =>
						url.searchParams.getAll(name).includes(value),
					),
				)
			);
		});
		if (!entry) throw new Error(`unmatched interaction: ${url.pathname}`);
		expect(init?.method ?? "GET").toBe(entry.request.method);
		const headers = new Headers(init?.headers);
		expect(headers.get("accept")).toBe(entry.request.headers.Accept);
		expect(headers.get("x-github-api-version")).toBe(
			entry.request.headers["X-GitHub-Api-Version"],
		);
		expect(headers.get("authorization")).toMatch(/^Bearer \S+$/u);
		matched.add(entry.description);
		return Response.json(entry.response.body, {
			status: entry.response.status,
		});
	};
}

function source(state: string, matched: Set<string>): GithubRouteFacts {
	return new GithubRouteFacts({
		token: "job-token-fixture",
		apiUrl: API,
		fetch: provider(state, matched),
		slipLabels: SLIP_LABELS,
	});
}

it("drives GithubRouteFacts through every interaction of the relay job facts pact", async () => {
	const matched = new Set<string>();
	const request = testRouteRequest(fixtures.repository, fixtures.ownRunId);

	const withSlip = source("a routing slip is published", matched);
	const published = await withSlip.facts(request, fixtures.nowMilliseconds);
	expect(withSlip.warnings).toEqual([]);
	expect(published.fleet).toEqual({
		enabled: true,
		taking: true,
		isolated: false,
	});

	const withoutSlip = source("no routing slip is published", matched);
	const missing = await withoutSlip.facts(request, fixtures.nowMilliseconds);
	expect(withoutSlip.warnings).toEqual([]);
	expect(missing.fleet?.enabled).toBe(true);
	expect(missing.fleet?.taking).toBe(true);

	expect([...matched].sort()).toEqual(
		pact.interactions.map((entry) => entry.description).sort(),
	);
});
