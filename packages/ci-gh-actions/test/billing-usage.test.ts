import { create } from "@bufbuild/protobuf";
import {
	answerRelayJob,
	JobFactSchema,
	type MinutesUsage,
	NO_ROUTE_FACTS,
} from "@hobo/ci";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	minutesReaderConformance,
	testRelayJobMessage,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	actionsMinutesUsed,
	GITHUB_INCLUDED_COMPUTE_SOURCE,
	GITHUB_INCLUDED_COMPUTE_USD,
	GithubMinutesReader,
	type GithubMinutesReaderDeps,
	githubBilledMinutes,
	includedMinutesOfPlan,
} from "../src/billing-usage.js";

const NOW = Date.UTC(2026, 10, 17, 12);
const BASE = "https://github.test";

type Route = Readonly<{ status: number; body: string }>;

/** A GitHub that answers the listed paths and refuses the rest with 404. */
function github(routes: ReadonlyMap<string, Route>) {
	const asked: string[] = [];
	const fetcher: typeof fetch = async (input) => {
		const url = new URL(String(input));
		const path = `${url.pathname}${url.search}`;
		asked.push(path);
		const route = routes.get(path);
		return new Response(route?.body ?? '{"message":"Not Found"}', {
			status: route?.status ?? 404,
		});
	};
	return { fetcher, asked };
}

const USAGE_PATH =
	"/organizations/octo/settings/billing/usage?year=2026&month=11";

function usageBody(grossUsd: readonly number[]): string {
	return JSON.stringify({
		usageItems: [
			...grossUsd.map((grossAmount) => ({
				date: "2026-11-02T00:00:00Z",
				product: "actions",
				sku: "actions_linux",
				quantity: Math.round(grossAmount / 0.006),
				unitType: "Minutes",
				pricePerUnit: 0.006,
				grossAmount,
				discountAmount: grossAmount,
				netAmount: 0,
				organizationName: "octo",
			})),
			{
				date: "2026-11-02T00:00:00Z",
				product: "actions",
				sku: "actions_storage",
				quantity: 5,
				unitType: "GigabyteHours",
				pricePerUnit: 0.008,
				grossAmount: 0.04,
				discountAmount: 0,
				netAmount: 0.04,
				organizationName: "octo",
			},
		],
	});
}

function reader(
	routes: ReadonlyMap<string, Route>,
	init: Partial<GithubMinutesReaderDeps> = {},
) {
	const fake = github(routes);
	let now = NOW;
	const minutes = new GithubMinutesReader({
		fetch: fake.fetcher,
		baseUrl: BASE,
		token: async () => "ghs_test",
		plan: undefined,
		recentMinutes: undefined,
		now: () => now,
		cacheMs: 60_000,
		...init,
	});
	return {
		minutes,
		asked: fake.asked,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const TEAM_ORG = new Map<string, Route>([
	[
		"/orgs/octo",
		{ status: 200, body: '{"login":"octo","plan":{"name":"team"}}' },
	],
	[USAGE_PATH, { status: 200, body: usageBody([6, 4.8]) }],
]);

describe("included compute per plan", () => {
	it("is read from GitHub's page and counted in Linux minutes", () => {
		expect(GITHUB_INCLUDED_COMPUTE_SOURCE).toMatch(
			/^https:\/\/docs\.github\.com\//u,
		);
		expect(includedMinutesOfPlan("free")).toBe(2_000);
		expect(includedMinutesOfPlan("Team")).toBe(3_000);
		expect(includedMinutesOfPlan("enterprise")).toBe(50_000);
		expect(includedMinutesOfPlan("legacy-plan")).toBeUndefined();
		expect([...GITHUB_INCLUDED_COMPUTE_USD.keys()]).toEqual([
			"free",
			"pro",
			"team",
			"enterprise",
		]);
	});

	it("counts only Actions compute minutes", () => {
		expect(
			actionsMinutesUsed([
				{
					product: "actions",
					unitType: "Minutes",
					quantity: 10,
					grossAmount: 0.06,
				},
				{ product: "Actions", unitType: "minutes", quantity: 3 },
				{
					product: "actions",
					unitType: "GigabyteHours",
					quantity: 99,
					grossAmount: 9,
				},
				{
					product: "copilot",
					unitType: "Minutes",
					quantity: 99,
					grossAmount: 9,
				},
			]),
		).toBeCloseTo(13, 10);
	});

	it("counts public-repository usage too (a known overcount)", () => {
		// GitHub discounts it in full, but it discounts the included allowance too:
		// the item alone cannot tell them apart, so the gross amount counts.
		expect(
			actionsMinutesUsed([
				{
					product: "actions",
					unitType: "Minutes",
					quantity: 100,
					grossAmount: 0.6,
				},
			]),
		).toBeCloseTo(100, 10);
	});
});

describe("GithubMinutesReader (R07)", () => {
	it("keeps the minutes reader's rules", async () => {
		await minutesReaderConformance(() => reader(TEAM_ORG).minutes);
	});

	it("reads an organization's usage against its plan", async () => {
		const { minutes, asked } = reader(TEAM_ORG);
		expect(await minutes.usage("octo")).toEqual({
			usedMinutes: 1_800,
			includedMinutes: 3_000,
		});
		expect(asked).toEqual(["/orgs/octo", USAGE_PATH]);
	});

	it("falls back to the user endpoints for a personal account", async () => {
		const { minutes } = reader(
			new Map([
				[
					"/users/mona",
					{ status: 200, body: '{"login":"mona","plan":{"name":"pro"}}' },
				],
				[
					"/users/mona/settings/billing/usage?year=2026&month=11",
					{ status: 200, body: usageBody([1.2]) },
				],
			]),
		);
		expect(await minutes.usage("mona")).toEqual({
			usedMinutes: 200,
			includedMinutes: 3_000,
		});
	});

	it("adds the burn of the last two hours from job facts", async () => {
		const asked: number[] = [];
		const { minutes } = reader(TEAM_ORG, {
			recentMinutes: async (_owner, sinceMs) => {
				asked.push(sinceMs);
				return 300;
			},
		});
		expect((await minutes.usage("octo"))?.burnPerHour).toBe(150);
		expect(asked).toEqual([NOW - 2 * 60 * 60_000]);
	});

	it("answers unmeasured, never throwing, without the permission or a token", async () => {
		const refused = new Map<string, Route>([
			["/orgs/octo", { status: 200, body: '{"plan":{"name":"team"}}' }],
			[
				USAGE_PATH,
				{
					status: 403,
					body: '{"message":"Resource not accessible by integration"}',
				},
			],
		]);
		expect(await reader(refused).minutes.usage("octo")).toBeUndefined();
		expect(
			await reader(TEAM_ORG, { token: async () => undefined }).minutes.usage(
				"octo",
			),
		).toBeUndefined();
		const broken = reader(TEAM_ORG, {
			fetch: async () => Promise.reject(new TypeError("fetch failed")),
		});
		expect(await broken.minutes.usage("octo")).toBeUndefined();
		const garbled = new Map<string, Route>([
			["/orgs/octo", { status: 200, body: '{"plan":{"name":"team"}}' }],
			[USAGE_PATH, { status: 200, body: "<html>" }],
		]);
		expect(await reader(garbled).minutes.usage("octo")).toBeUndefined();
		const unknownPlan = new Map<string, Route>([
			["/orgs/octo", { status: 200, body: '{"plan":{"name":"legacy"}}' }],
			[USAGE_PATH, { status: 200, body: usageBody([1]) }],
		]);
		expect(await reader(unknownPlan).minutes.usage("octo")).toBeUndefined();
	});

	it("takes a plan the caller knows instead of reading it", async () => {
		const { minutes, asked } = reader(
			new Map([[USAGE_PATH, { status: 200, body: usageBody([3]) }]]),
			{
				plan: async () => "enterprise",
			},
		);
		expect(await minutes.usage("octo")).toEqual({
			usedMinutes: 500,
			includedMinutes: 50_000,
		});
		expect(asked).toEqual([USAGE_PATH]);
	});

	it("reuses one reading for the cache span", async () => {
		const { minutes, asked, advance } = reader(TEAM_ORG);
		await minutes.usage("octo");
		await minutes.usage("Octo");
		expect(asked).toHaveLength(2);
		advance(60_000);
		await minutes.usage("octo");
		expect(asked).toHaveLength(4);
	});

	it("feeds the walk: the github step is used under its limit and passed over at it", async () => {
		const answer = async (usage: MinutesUsage | undefined) => {
			const journal = new InMemoryRouteJournal();
			const result = await answerRelayJob(
				testRelayJobMessage({
					inputs: [
						["github", "ubuntu-24.04"],
						["depot", "depot-ubuntu-24.04"],
					],
				}),
				{
					order: new InMemoryRunnerOrderSource(
						new Map([
							[
								"octo/app",
								'{"steps":[{"key":"github","minutesLimitPercent":80},{"key":"depot"}]}',
							],
						]),
					),
					facts: new InMemoryRouteFactsSource(() => ({
						...NO_ROUTE_FACTS,
						minutes: usage,
					})),
					journal,
					nowMs: NOW,
					mode: "relay",
					node: "node-1",
					accountId: "acct-1",
					checks: undefined,
				},
			);
			const runner = result.outputs.find(
				(output) => output.name === "runner",
			)?.value;
			const skipped = journal.events
				.find((event) => event.type === "runner.route.Decided")
				?.decision?.skipped.map((skip) => skip.reason);
			return { runner, skipped };
		};
		const under = await answer(await reader(TEAM_ORG).minutes.usage("octo"));
		expect(under.runner).toBe("ubuntu-24.04");
		const over = await answer(
			await reader(
				new Map([
					["/orgs/octo", { status: 200, body: '{"plan":{"name":"team"}}' }],
					[USAGE_PATH, { status: 200, body: usageBody([15]) }],
				]),
			).minutes.usage("octo"),
		);
		expect(over).toEqual({
			runner: "depot-ubuntu-24.04",
			skipped: ["minutes_limit"],
		});
		const runway = await answer(
			await reader(TEAM_ORG, {
				recentMinutes: async () => 1_300,
			}).minutes.usage("octo"),
		);
		expect(runway).toEqual({
			runner: "depot-ubuntu-24.04",
			skipped: ["minutes_runway"],
		});
		const unmeasured = await answer(
			await reader(new Map()).minutes.usage("octo"),
		);
		expect(unmeasured.runner).toBe("ubuntu-24.04");
	});
});

describe("githubBilledMinutes", () => {
	it("sums the part of each billed GitHub-hosted job inside the window", () => {
		const job = (init: Parameters<typeof create<typeof JobFactSchema>>[1]) =>
			create(JobFactSchema, {
				name: "test",
				conclusion: "success",
				billed: true,
				...init,
			});
		const since = NOW - 2 * 60 * 60_000;
		expect(
			githubBilledMinutes(
				[
					job({
						id: 1,
						labels: ["ubuntu-24.04"],
						startedAtMs: since - 600_000,
						completedAtMs: since + 600_000,
					}),
					job({ id: 2, labels: ["ubuntu-24.04"], startedAtMs: NOW - 300_000 }),
					job({
						id: 3,
						labels: ["depot-ubuntu-24.04"],
						startedAtMs: NOW - 300_000,
						completedAtMs: NOW,
					}),
					job({
						id: 4,
						labels: ["ubuntu-24.04"],
						billed: false,
						startedAtMs: NOW - 300_000,
						completedAtMs: NOW,
					}),
				],
				since,
				NOW,
			),
		).toBe(15);
	});
});
