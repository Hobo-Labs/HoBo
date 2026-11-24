import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	DASHBOARD_VIEWS,
	DashboardApiError,
	DashboardReadApi,
	loadView,
	parseDashboardLocation,
} from "../src/index.js";
import {
	type AskedRequest,
	PACT_NOW_MS,
	PACT_REPOSITORY,
	PACT_TOKEN,
	pactReadApi,
} from "./support/pact-read-api.js";

const ORIGIN = "https://relay.example.test";
const CONSUMER_PACT = new URL(
	"../contracts/read-api.pact.json",
	import.meta.url,
);

function api(token = PACT_TOKEN) {
	const mock = pactReadApi();
	const client = new DashboardReadApi(ORIGIN, token, async (url, init) => {
		const answer = await mock.handle(new Request(url, init));
		if (!answer) throw new Error(`not a read API path: ${url}`);
		return answer;
	});
	return { mock, client };
}

async function everything(): Promise<readonly AskedRequest[]> {
	const { mock, client } = api();
	for (const view of DASHBOARD_VIEWS)
		await loadView(
			client,
			parseDashboardLocation(`#/${view}`, PACT_REPOSITORY),
			PACT_NOW_MS,
		);
	await loadView(
		client,
		parseDashboardLocation(
			`#/history/${PACT_REPOSITORY}/102/1`,
			PACT_REPOSITORY,
		),
		PACT_NOW_MS,
	);
	await loadView(
		client,
		parseDashboardLocation("#/signals", undefined),
		PACT_NOW_MS,
	).catch(() => undefined);
	const forbidden = api("token-write");
	await forbidden.client.machines().catch(() => undefined);
	const other = api("token-b");
	await other.client.runs(PACT_REPOSITORY).catch(() => undefined);
	return [...mock.asked, ...forbidden.mock.asked, ...other.mock.asked];
}

function consumerPact(asked: readonly AskedRequest[]): string {
	const seen = new Set<string>();
	const interactions = asked.flatMap((entry) => {
		const key = `${entry.authorization} ${entry.url}`;
		const provider = entry.interaction;
		if (seen.has(key) || provider === undefined) return [];
		seen.add(key);
		const url = new URL(entry.url, ORIGIN);
		const query = new Map<string, string[]>();
		for (const [name, value] of url.searchParams) query.set(name, [value]);
		const request = {
			method: entry.method,
			path: url.pathname,
			query: Object.fromEntries(query),
			headers: { authorization: entry.authorization },
		};
		return [
			{
				description: `the dashboard: ${provider.description}`,
				providerState: provider.providerState ?? "",
				request,
				response: {
					status: provider.response.status,
					headers: { "content-type": "application/json" },
					body: provider.response.body,
				},
			},
		];
	});
	return `${JSON.stringify(
		{
			consumer: { name: "HoBoCiDashboard" },
			provider: { name: "HoBoCiRelayReadApi" },
			interactions,
			metadata: { pactSpecification: { version: "3.0.0" } },
		},
		null,
		"\t",
	)}\n`;
}

describe("the dashboard against the read API pact", () => {
	it("makes only requests the provider pact covers, all GET, and the committed pact is what it sends", async () => {
		const asked = await everything();
		expect(asked.filter((entry) => entry.interaction === undefined)).toEqual(
			[],
		);
		expect(new Set(asked.map((entry) => entry.method))).toEqual(
			new Set(["GET"]),
		);
		const paths = new Set(asked.map((entry) => entry.url.split("?")[0]));
		expect([...paths].sort()).toEqual([
			"/v1/accounts/self/job-times",
			"/v1/accounts/self/machines",
			"/v1/accounts/self/routes",
			"/v1/accounts/self/runner-order",
			"/v1/accounts/self/runs",
			"/v1/accounts/self/runs/102/1/jobs",
			"/v1/accounts/self/signals",
		]);
		const derived = consumerPact(asked);
		if (process.env.UPDATE_PACT === "1") writeFileSync(CONSUMER_PACT, derived);
		expect(derived).toBe(readFileSync(CONSUMER_PACT, "utf8"));
	});

	it("parses every 200 body into checked records", async () => {
		const { client } = api();
		const order = await client.runnerOrder(PACT_REPOSITORY);
		expect(order.problem).toBe("");
		expect(order.order.steps.map((step) => step.key)).toEqual([
			"machine",
			"github",
		]);
		const routes = await client.routes(PACT_REPOSITORY);
		expect(routes[0]?.decision?.runner).toBe("ubuntu-24.04");
		const machines = await client.machines();
		expect(machines.map((machine) => machine.id)).toEqual(["m-a"]);
		const runs = await client.runs(PACT_REPOSITORY);
		expect(runs.map((run) => run.id)).toEqual([102, 101]);
		const run = runs[0];
		if (!run) throw new Error("no run");
		const withJobs = await client.runWithJobs(run);
		expect(withJobs.jobs.map((job) => job.name)).toEqual(["test", "lint"]);
		expect(withJobs.workflow).toBe("CI");
		const signals = await client.signals(PACT_REPOSITORY);
		expect(signals.signals.signals).toHaveLength(9);
		const times = await client.jobTimes(PACT_REPOSITORY);
		expect(times.workflows[0]?.workflow).toBe("CI");
	});

	it("reads the refusals as errors with their code and command", async () => {
		const forbidden = await api("token-write")
			.client.machines()
			.catch((error: Error) => error);
		expect(forbidden).toBeInstanceOf(DashboardApiError);
		expect(forbidden).toMatchObject({ status: 403, code: "forbidden" });

		const other = await api("token-b")
			.client.runs(PACT_REPOSITORY)
			.catch((error: Error) => error);
		expect(other).toMatchObject({ status: 404, code: "not-found" });

		const notStored = await api()
			.client.signals(undefined)
			.catch((error: Error) => error);
		expect(notStored).toMatchObject({
			status: 404,
			code: "not-stored-here",
			command: "hobo ci signals",
		});
	});
});
