import { monthStartMs } from "@hobo/ci";
import {
	InMemorySpendReader,
	spendReaderConformance,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	DepotUsageReader,
	envCredentialResolver,
	namespacePeriod,
	PROVIDER_USAGE_MAX_AGE_MS,
	PROVIDER_USAGE_SYNC_INTERVAL_MS,
	type ProviderUsageReader,
	type ProviderUsageSubscription,
	ProviderUsageSync,
	parseProviderUsageSubscription,
	providerUsageReaders,
	SyncedSpendReader,
	scheduleProviderUsageSync,
	type UsageReadRequest,
	type UsageSyncProvider,
} from "../src/provider-usage/index.js";

const NOW = Date.UTC(2026, 10, 17, 12);
const MONTH = monthStartMs(NOW);

describe("parseProviderUsageSubscription", () => {
	it("keeps a reference and defaults Namespace's region", () => {
		expect(
			parseProviderUsageSubscription({
				accountId: "acct-1",
				provider: "Namespace",
				credential: "env:NAMESPACE_USAGE_TOKEN",
			}),
		).toEqual({
			accountId: "acct-1",
			provider: "namespace",
			credential: "env:NAMESPACE_USAGE_TOKEN",
			region: "us",
		});
		expect(
			parseProviderUsageSubscription({
				accountId: "acct-1",
				provider: "depot",
				credential: "github-secret:DEPOT_TOKEN",
			}).region,
		).toBeUndefined();
	});

	it("refuses a token value without repeating it", () => {
		const token = "Xk2q9VbN4mT7rL1pZ8sW3yH6jD5fG0aQ";
		expect(() =>
			parseProviderUsageSubscription({
				accountId: "acct-1",
				provider: "warpbuild",
				credential: token,
			}),
		).toThrow(/looks like a token; give a reference/u);
		try {
			parseProviderUsageSubscription({
				accountId: "acct-1",
				provider: "warpbuild",
				credential: token,
			});
		} catch (error) {
			expect(String(error)).not.toContain(token);
		}
	});

	it("refuses an unknown provider, a stray region and a bad region", () => {
		expect(() =>
			parseProviderUsageSubscription({
				accountId: "a",
				provider: "blacksmith",
				credential: "env:X",
			}),
		).toThrow(/only from depot, namespace, warpbuild/u);
		expect(() =>
			parseProviderUsageSubscription({
				accountId: "a",
				provider: "depot",
				credential: "env:X",
				region: "eu",
			}),
		).toThrow(/only a namespace subscription names a region/u);
		expect(() =>
			parseProviderUsageSubscription({
				accountId: "a",
				provider: "namespace",
				credential: "env:X",
				region: "eu.evil.example",
			}),
		).toThrow(/not a Namespace region/u);
		expect(() =>
			parseProviderUsageSubscription({
				accountId: " ",
				provider: "depot",
				credential: "env:X",
			}),
		).toThrow(/account id/u);
	});
});

describe("envCredentialResolver", () => {
	it("reads env: references only", async () => {
		const resolve = envCredentialResolver({
			DEPOT_USAGE: " value ",
			EMPTY: "",
		});
		expect(await resolve("env:DEPOT_USAGE")).toBe("value");
		expect(await resolve("env:EMPTY")).toBeUndefined();
		expect(await resolve("env:MISSING")).toBeUndefined();
		expect(await resolve("github-secret:DEPOT_USAGE")).toBeUndefined();
	});
});

describe("namespacePeriod", () => {
	it("gives the inclusive days of the window inside one month", () => {
		expect(namespacePeriod(MONTH, NOW)).toEqual({
			periodStart: { year: 2026, month: 11, day: 1 },
			periodEnd: { year: 2026, month: 11, day: 17 },
		});
		// An end at midnight does not include the day it starts.
		expect(namespacePeriod(MONTH, Date.UTC(2026, 10, 3))).toEqual({
			periodStart: { year: 2026, month: 11, day: 1 },
			periodEnd: { year: 2026, month: 11, day: 2 },
		});
		// A window past the month stops at the month's last day.
		expect(namespacePeriod(MONTH, Date.UTC(2026, 11, 5)).periodEnd).toEqual({
			year: 2026,
			month: 11,
			day: 30,
		});
	});
});

type DepotReply = Readonly<{ actualCost?: number | string; currency?: string }>;

describe("DepotUsageReader", () => {
	const read = async (body: DepotReply, status = 200) =>
		new DepotUsageReader({
			fetch: async () => Response.json(body, { status }),
			timeoutMs: 1000,
			baseUrl: "https://depot.test/",
		}).spentUsd({
			window: { startMs: MONTH, endMs: NOW },
			token: "t",
			region: undefined,
		});

	it("reads cents of US dollars, numeric or string", async () => {
		expect(await read({ actualCost: 250, currency: "USD" })).toBe(2.5);
		expect(await read({ actualCost: "250", currency: "usd" })).toBe(2.5);
		// proto3 JSON leaves a zero cost out.
		expect(await read({})).toBe(0);
	});

	it("leaves another currency, a bad shape or a refusal unmeasured", async () => {
		expect(await read({ actualCost: 250, currency: "EUR" })).toBeUndefined();
		expect(await read({ actualCost: 250 })).toBeUndefined();
		expect(await read({ actualCost: "lots" })).toBeUndefined();
		expect(await read({ actualCost: -5, currency: "USD" })).toBeUndefined();
		expect(await read({}, 500)).toBeUndefined();
	});

	it("never throws when the network does", async () => {
		const reader = new DepotUsageReader({
			fetch: async () => {
				throw new Error("offline");
			},
			timeoutMs: 1000,
			baseUrl: "https://depot.test",
		});
		expect(
			await reader.spentUsd({
				window: { startMs: MONTH, endMs: NOW },
				token: "t",
				region: undefined,
			}),
		).toBeUndefined();
	});
});

it("builds the three readers against the vendors' own APIs", async () => {
	const asked: string[] = [];
	const readers = providerUsageReaders(async (input) => {
		asked.push(String(input).split("?")[0] ?? "");
		return Response.json({}, { status: 401 });
	});
	expect([...readers.keys()]).toEqual(["depot", "namespace", "warpbuild"]);
	for (const reader of readers.values())
		await reader.spentUsd({
			window: { startMs: MONTH, endMs: NOW },
			token: "t",
			region: "eu",
		});
	expect(asked).toEqual([
		"https://api.depot.dev/depot.core.v1.GithubActionsService/GetGithubActionsUsageProjection",
		"https://eu.compute.namespaceapis.com/namespace.cloud.compute.v1beta.UsageService/GetUsage",
		"https://api.warpbuild.com/api/v1/reports/billing/ci",
	]);
});

/** A reader whose answer a test sets; records each request it was given. */
class ScriptedReader implements ProviderUsageReader {
	readonly source: string;
	answer: number | undefined | "throw";
	readonly requests: UsageReadRequest[] = [];
	constructor(
		readonly provider: UsageSyncProvider,
		answer: number | undefined,
	) {
		this.source = `https://${provider}.example/usage`;
		this.answer = answer;
	}
	async spentUsd(request: UsageReadRequest): Promise<number | undefined> {
		this.requests.push(request);
		if (this.answer === "throw") throw new Error("boom");
		return this.answer;
	}
}

function world(nowMs = NOW) {
	const clock = { nowMs };
	const depot = new ScriptedReader("depot", 120);
	const namespace = new ScriptedReader("namespace", 60);
	const warpbuild = new ScriptedReader("warpbuild", 40);
	const subscriptions: ProviderUsageSubscription[] = [
		{
			accountId: "acct-1",
			provider: "depot",
			credential: "env:DEPOT",
			region: undefined,
		},
		{
			accountId: "acct-1",
			provider: "namespace",
			credential: "env:NAMESPACE",
			region: "eu",
		},
		{
			accountId: "acct-1",
			provider: "warpbuild",
			credential: "env:WARPBUILD",
			region: undefined,
		},
	];
	const env: NodeJS.ProcessEnv = {
		DEPOT: "depot-secret-value",
		NAMESPACE: "namespace-secret-value",
		WARPBUILD: "warpbuild-secret-value",
	};
	const sync = new ProviderUsageSync({
		subscriptions: async () => subscriptions,
		readers: new Map<UsageSyncProvider, ProviderUsageReader>([
			["depot", depot],
			["namespace", namespace],
			["warpbuild", warpbuild],
		]),
		credentials: envCredentialResolver(env),
		now: () => clock.nowMs,
	});
	const ledger = new InMemorySpendReader(
		new Map([
			[
				"acct-1",
				new Map([
					["depot", 1],
					["warpbuild", 2],
					["blacksmith", 5],
				] as const),
			],
		]),
	);
	const spend = new SyncedSpendReader({
		sync,
		fallback: ledger,
		now: () => clock.nowMs,
		maxAgeMs: PROVIDER_USAGE_MAX_AGE_MS,
	});
	return {
		clock,
		depot,
		namespace,
		warpbuild,
		subscriptions,
		env,
		sync,
		ledger,
		spend,
	};
}

describe("ProviderUsageSync and SyncedSpendReader", () => {
	it("passes the spend reader conformance", async () => {
		await spendReaderConformance(() => world().spend);
	});

	it("reads this month from each vendor first and the ledger for the rest", async () => {
		const w = world();
		const outcomes = await w.sync.syncOnce();
		expect(outcomes.map((o) => [o.provider, o.outcome, o.spentUsd])).toEqual([
			["depot", "synced", 120],
			["namespace", "synced", 60],
			["warpbuild", "synced", 40],
		]);
		expect(w.namespace.requests[0]).toEqual({
			window: { startMs: MONTH, endMs: NOW },
			token: "namespace-secret-value",
			region: "eu",
		});
		expect(Object.fromEntries(await w.spend.spentUsd("acct-1", MONTH))).toEqual(
			{
				depot: 120,
				namespace: 60,
				warpbuild: 40,
				blacksmith: 5,
			},
		);
		// Another account has nothing synced and gets the ledger's answer.
		expect((await w.spend.spentUsd("acct-2", MONTH)).size).toBe(0);
	});

	it("keeps no token in a reading or an outcome", async () => {
		const w = world();
		const outcomes = await w.sync.syncOnce();
		const kept = JSON.stringify([outcomes, w.sync.readings("acct-1")]);
		for (const value of Object.values(w.env))
			expect(kept).not.toContain(String(value));
	});

	it("drops a provider to the ledger when its read fails, its token goes or it throws", async () => {
		const w = world();
		await w.sync.syncOnce();
		w.warpbuild.answer = undefined;
		w.depot.answer = "throw";
		delete w.env.NAMESPACE;
		const outcomes = await w.sync.syncOnce();
		expect(outcomes.map((o) => o.outcome)).toEqual([
			"unmeasured",
			"no-credential",
			"unmeasured",
		]);
		expect(Object.fromEntries(await w.spend.spentUsd("acct-1", MONTH))).toEqual(
			{
				depot: 1,
				warpbuild: 2,
				blacksmith: 5,
			},
		);
	});

	it("passes over a stale reading and one for another month", async () => {
		const w = world();
		await w.sync.syncOnce();
		w.clock.nowMs = NOW + PROVIDER_USAGE_MAX_AGE_MS + 1;
		expect((await w.spend.spentUsd("acct-1", MONTH)).get("depot")).toBe(1);
		w.clock.nowMs = NOW;
		const earlier = monthStartMs(MONTH - 1);
		expect(w.ledger.asked.length).toBe(1);
		expect((await w.spend.spentUsd("acct-1", earlier)).get("depot")).toBe(1);
	});

	it("still answers the vendor figures when the ledger fails", async () => {
		const w = world();
		await w.sync.syncOnce();
		const spend = new SyncedSpendReader({
			sync: w.sync,
			fallback: {
				spentUsd: async () => {
					throw new Error("ledger down");
				},
			},
			now: () => NOW,
			maxAgeMs: PROVIDER_USAGE_MAX_AGE_MS,
		});
		expect(Object.fromEntries(await spend.spentUsd("acct-1", MONTH))).toEqual({
			depot: 120,
			namespace: 60,
			warpbuild: 40,
		});
	});

	it("survives subscriptions that cannot be read, and a provider with no reader", async () => {
		const failing = new ProviderUsageSync({
			subscriptions: async () => {
				throw new Error("config unreadable");
			},
			readers: new Map(),
			credentials: async () => "t",
			now: () => NOW,
		});
		expect(await failing.syncOnce()).toEqual([]);
		const bare = new ProviderUsageSync({
			subscriptions: async () => [
				{
					accountId: "a",
					provider: "depot",
					credential: "env:X",
					region: undefined,
				},
			],
			readers: new Map(),
			credentials: async () => "t",
			now: () => NOW,
		});
		expect((await bare.syncOnce())[0]?.outcome).toBe("no-reader");
	});
});

describe("scheduleProviderUsageSync", () => {
	it("syncs at once, then hourly, one sync at a time, until stopped", async () => {
		const w = world();
		let tick: (() => void) | undefined;
		let interval = 0;
		let cleared = false;
		const stop = scheduleProviderUsageSync(w.sync, {
			setInterval: (run, ms) => {
				tick = run;
				interval = ms;
				return setTimeout(() => undefined, 0);
			},
			clearInterval: () => {
				cleared = true;
			},
		});
		expect(interval).toBe(PROVIDER_USAGE_SYNC_INTERVAL_MS);
		// The first sync is still running: a tick now is skipped.
		tick?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(w.depot.requests).toHaveLength(1);
		tick?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(w.depot.requests).toHaveLength(2);
		stop();
		expect(cleared).toBe(true);
	});
});
