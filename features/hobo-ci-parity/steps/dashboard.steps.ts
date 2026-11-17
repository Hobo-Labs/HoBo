/**
 * Steps for gauntlet cases S01 and S10 (features/hobo-ci-parity/surfaces.feature):
 * the relay dashboard (`@hobo/ci-dashboard`) mounted beside the relay's real
 * read API (`createReadApi`) over in-memory stores, read through the same
 * `loadView` the browser client calls. Every request the dashboard makes is
 * kept. No step reaches the network.
 */
import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import type { RunnerOrderLookup, RunnerOrderSource } from "../../../packages/ci/src/runner-order/ports.js";
import {
	DEFAULT_RUNNER_ORDER,
	parseRunnerOrder,
} from "../../../packages/ci/src/runner-order/order.js";
import {
	InMemoryInsightStore,
	InMemoryMachineRegistry,
	InMemoryRouteJournal,
} from "../../../packages/ci/src/runner-order/testing.js";
import { loadView } from "../../../packages/ci-dashboard/src/load.js";
import { parseDashboardLocation } from "../../../packages/ci-dashboard/src/location.js";
import { DashboardReadApi } from "../../../packages/ci-dashboard/src/read-api.js";
import { createDashboardRoute } from "../../../packages/ci-dashboard/src/route.js";
import { DASHBOARD_VIEWS, PROJECT_CONFIG_PATH } from "../../../packages/ci-dashboard/src/views.js";
import { createReadApi } from "../../../packages/ci-gh-actions/src/read-api.js";
import {
	NOW,
	type ReadApiFixture,
	GITHUB_RATE,
	readApiFixture,
} from "../../../packages/ci-gh-actions/test/support/read-api-fixture.js";

const ORIGIN = "https://relay.test";
const REPOSITORY = "octo/app";

type Handler = (request: Request) => Promise<Response | undefined>;

type DashboardState = {
	handle: Handler;
	fixture: ReadApiFixture | undefined;
	orders: BranchOrders | undefined;
	requests: { method: string; path: string }[];
	views: Map<string, string>;
	before: string;
	editUrl: string;
};

let state: DashboardState;

/** A relay with the dashboard mounted first and the read API behind it. */
function mounted(readApi: Handler): Handler {
	const dashboard = createDashboardRoute({ script: "/* client */" });
	return async (request) => {
		state.requests.push({ method: request.method, path: new URL(request.url).pathname });
		return (await dashboard(request)) ?? (await readApi(request));
	};
}

function client(): DashboardReadApi {
	return new DashboardReadApi(ORIGIN, "token-a", async (url, init) => {
		const answer = await state.handle(new Request(url, init));
		assert.ok(answer, `no route answered ${url}`);
		return answer;
	});
}

async function view(hash: string): Promise<string> {
	return (await loadView(client(), parseDashboardLocation(hash, REPOSITORY), NOW)).html;
}

/** What the stores hold, as text, so a change to any of them shows. */
async function stores(fixture: ReadApiFixture): Promise<string> {
	return JSON.stringify({
		routes: (
			await fixture.journal.decisions({ accountId: "acct-a", repository: undefined, sinceMs: 0, limit: 1000 })
		).map((event) => event.jobId),
		machines: (await fixture.machines.list("acct-a")).map((machine) => [machine.id, machine.paused, machine.sharing]),
		changes: fixture.machines.changes.length,
		runs: (await fixture.insights.runs({ repository: REPOSITORY, sinceMs: 0, limit: 1000 })).map((run) => run.id),
	});
}

/**
 * `.hobo/ci.json`'s `runnerOrder` by branch, as GitHub holds it. The relay
 * reads the default branch's when asked for no ref, as the dashboard asks.
 */
class BranchOrders implements RunnerOrderSource {
	readonly branches = new Map<string, string>([["main", '{"steps":[{"key":"machine"},{"key":"github"}]}']]);

	async order(_repository: string, ref: string | undefined): Promise<RunnerOrderLookup> {
		const json = this.branches.get(ref ?? "main");
		return { order: json === undefined ? DEFAULT_RUNNER_ORDER : parseRunnerOrder(json), problem: "" };
	}
}

Before({ tags: "@S01 or @S10" }, () => {
	state = {
		handle: async () => undefined,
		fixture: undefined,
		orders: undefined,
		requests: [],
		views: new Map(),
		before: "",
		editUrl: "",
	};
});

Given("a relay with stored routes, machines and runs", async () => {
	const fixture = await readApiFixture();
	state.fixture = fixture;
	state.handle = mounted(fixture.handle);
	state.before = await stores(fixture);
});

When("the dashboard is opened", async () => {
	const page = await state.handle(new Request(`${ORIGIN}/dashboard`));
	assert.equal(page?.status, 200);
	const html = (await page?.text()) ?? "";
	for (const name of DASHBOARD_VIEWS) assert.ok(html.includes(`href="#/${name}"`), `navigation to ${name}`);
	for (const name of DASHBOARD_VIEWS) state.views.set(name, await view(`#/${name}`));
	state.views.set("run", await view(`#/history/${REPOSITORY}/102/1`));
});

Then("it shows the Runners, Router, History, Performance and Signals views", () => {
	const shown = (name: string) => state.views.get(name) ?? "";
	assert.match(shown("runners"), /<h2 id="attention-heading">Needs attention \(\d+\)<\/h2>/u);
	assert.match(shown("runners"), /<h2 id="machines-heading">Machines \(1\)<\/h2>/u);
	assert.ok(!shown("runners").includes("m-b"), "another account's machine is not shown");
	assert.ok(shown("router").includes("Runner order · octo/app"));
	assert.ok(shown("router").includes("Recent decisions"));
	assert.ok(shown("router").includes('<form id="what-if"'));
	assert.ok(shown("history").includes('href="#/history/octo/app/102/1"'));
	assert.ok(shown("run").includes('<h2 id="run-heading">'));
	assert.ok(shown("performance").includes("Times by workflow"));
	assert.equal(shown("signals").match(/<li class="signal"/gu)?.length, 9);
	assert.ok(shown("signals").includes("Breakdown"));
	assert.ok(shown("signals").includes("Trend"));
});

Then("none of them changes anything", async () => {
	assert.ok(state.requests.length >= 10);
	for (const request of state.requests) {
		assert.equal(request.method, "GET", `${request.method} ${request.path}`);
		assert.ok(request.path === "/dashboard" || request.path.startsWith("/v1/accounts/self/"), request.path);
	}
	assert.ok(state.fixture);
	assert.equal(await stores(state.fixture), state.before);
});

Given("the dashboard's Router view", async () => {
	const orders = new BranchOrders();
	state.orders = orders;
	state.handle = mounted(
		createReadApi({
			authenticate: (authorization) =>
				authorization === "Bearer token-a"
					? { accountId: "acct-a", installationIds: [], scopes: ["policy:read"] }
					: undefined,
			repositories: async () => [{ name: REPOSITORY, public: false }],
			order: orders,
			journal: new InMemoryRouteJournal(),
			machines: new InMemoryMachineRegistry(),
			insights: new InMemoryInsightStore(),
			minutes: undefined,
			githubRate: GITHUB_RATE,
			nowMs: () => NOW,
		}),
	);
	const router = await view("#/router");
	state.views.set("router", router);
	assert.match(router, /<strong>machine<\/strong>.*<strong>github<\/strong>/su);
	const edit = /<a class="action" href="([^"]+)"[^>]*data-edit="runner-order"/u.exec(router);
	assert.ok(edit?.[1], "the Router view has an edit link");
	state.editUrl = edit[1];
});

When("an edit to the runner order is saved", () => {
	// GitHub's editor saves the edit as a commit on a new branch and opens a
	// pull request from it; the dashboard has no part in that and writes nothing.
	assert.equal(state.editUrl, `https://github.com/octo/app/edit/HEAD/${PROJECT_CONFIG_PATH}`);
	state.orders?.branches.set("hobo-edit-runner-order", '{"steps":[{"key":"github"}]}');
});

Then(
	"a pull request changing {string} is opened and nothing changes until it merges",
	async (path: string) => {
		assert.equal(path, PROJECT_CONFIG_PATH);
		assert.ok(state.editUrl.endsWith(`/${path}`), "the edit opens that file in GitHub's editor");
		assert.ok(state.requests.every((request) => request.method === "GET"), "the dashboard wrote nothing");
		const unmerged = await view("#/router");
		assert.match(unmerged, /<strong>machine<\/strong>.*<strong>github<\/strong>/su, "the open pull request changes nothing");
		state.orders?.branches.set("main", '{"steps":[{"key":"github"}]}');
		const merged = await view("#/router");
		assert.ok(!merged.includes("<strong>machine</strong>"), "the merged order is the one the relay reads");
	},
);
