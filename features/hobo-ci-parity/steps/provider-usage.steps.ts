import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";
import { monthStartMs } from "../../../packages/ci/src/runner-order/spend.js";
import {
	type HostedRunnerProvider,
	isHostedRunnerProvider,
} from "../../../packages/ci/src/runner-order/providers.js";
import { InMemorySpendReader } from "../../../packages/ci/src/runner-order/testing.js";
import {
	DepotUsageReader,
	NamespaceUsageReader,
	ownerStoreCredentialResolver,
	PROVIDER_USAGE_MAX_AGE_MS,
	PROVIDER_USAGE_TIMEOUT_MS,
	type ProviderUsageReader,
	type ProviderUsageSubscription,
	ProviderUsageSync,
	type ProviderUsageSyncOutcome,
	parseProviderUsageSubscription,
	SyncedSpendReader,
	type UsageSyncProvider,
	WarpbuildUsageReader,
} from "../../../packages/ci-gh-actions/src/provider-usage/index.js";
import {
	USAGE_PACT_ORIGINS,
	type UsagePactFake,
	usagePactFake,
} from "../../../packages/ci-gh-actions/test/support/provider-usage-pact.js";

const NOW = Date.UTC(2026, 10, 17, 12);
const ACCOUNT = "acct-1";

type UsageState = {
	stored: Map<string, string>;
	subscriptions: ProviderUsageSubscription[];
	ledger: Map<HostedRunnerProvider, number>;
	fake: UsagePactFake;
	sync: ProviderUsageSync;
	outcomes: readonly ProviderUsageSyncOutcome[];
};

let usage: UsageState;

function readersOver(
	fake: UsagePactFake,
): ReadonlyMap<UsageSyncProvider, ProviderUsageReader> {
	const http = { fetch: fake.fetch, timeoutMs: PROVIDER_USAGE_TIMEOUT_MS };
	return new Map<UsageSyncProvider, ProviderUsageReader>([
		["depot", new DepotUsageReader({ ...http, baseUrl: USAGE_PACT_ORIGINS.depot })],
		[
			"namespace",
			new NamespaceUsageReader({
				...http,
				originOf: (region) =>
					USAGE_PACT_ORIGINS.namespace.replace("us.", `${region}.`),
			}),
		],
		[
			"warpbuild",
			new WarpbuildUsageReader({
				...http,
				baseUrl: USAGE_PACT_ORIGINS.warpbuild,
			}),
		],
	]);
}

Before({ tags: "@P02" }, () => {
	const stored = new Map<string, string>();
	const fake = usagePactFake();
	const subscriptions: ProviderUsageSubscription[] = [];
	usage = {
		stored,
		subscriptions,
		ledger: new Map(),
		fake,
		sync: new ProviderUsageSync({
			subscriptions: async () => subscriptions,
			readers: readersOver(fake),
			credentials: ownerStoreCredentialResolver({
				resolve: async (ref) => {
					const token = stored.get(ref);
					if (token === undefined) throw new Error(`${ref} is not stored`);
					return { token };
				},
			}),
			now: () => NOW,
		}),
		outcomes: [],
	};
});

Given("read-only usage tokens for depot, namespace and warpbuild", () => {
	for (const provider of ["depot", "namespace", "warpbuild"] as const) {
		const reference = `owner://${provider.toUpperCase()}_USAGE_TOKEN`;
		usage.stored.set(reference, `${provider}-usage-token`);
		usage.subscriptions.push(
			parseProviderUsageSubscription({
				accountId: ACCOUNT,
				provider,
				credential: reference,
			}),
		);
	}
});

Given("the ledger holds this month's spend:", (table: DataTable) => {
	for (const row of table.hashes()) {
		const provider = row.provider;
		assert.ok(
			isHostedRunnerProvider(provider),
			`${provider} is a hosted runner provider`,
		);
		usage.ledger.set(provider, Number(row.usd));
	}
});

When("provider usage is synced from the simulated provider APIs", async () => {
	usage.outcomes = await usage.sync.syncOnce();
});

When(
	"the {string} token is revoked and provider usage is synced again",
	async (provider: string) => {
		usage.stored.set(
			`owner://${provider.toUpperCase()}_USAGE_TOKEN`,
			`${provider}-revoked-token`,
		);
		usage.outcomes = await usage.sync.syncOnce();
	},
);

Then(
	"the spend limit reads this month's spend per provider:",
	async (table: DataTable) => {
		const spend = new SyncedSpendReader({
			sync: usage.sync,
			fallback: new InMemorySpendReader(new Map([[ACCOUNT, usage.ledger]])),
			now: () => NOW,
			maxAgeMs: PROVIDER_USAGE_MAX_AGE_MS,
		});
		const read = await spend.spentUsd(ACCOUNT, monthStartMs(NOW));
		const expected = new Map(
			table.hashes().map((row) => [row.provider, Number(row.usd)]),
		);
		assert.deepEqual(
			[...read.keys()].sort(),
			[...expected.keys()].sort(),
			"the providers with a measured spend",
		);
		for (const [provider, usd] of expected) {
			assert.ok(
				isHostedRunnerProvider(provider),
				`${provider} is a hosted runner provider`,
			);
			const got = read.get(provider);
			assert.ok(
				got !== undefined && Math.abs(got - usd) < 1e-9,
				`${provider}: expected ${usd}, read ${got}`,
			);
		}
	},
);

Then("the sync outcomes are:", (table: DataTable) => {
	assert.deepEqual(
		usage.outcomes.map((outcome) => [outcome.provider, outcome.outcome]),
		table.hashes().map((row) => [row.provider, row.outcome]),
	);
});

Then("every provider API call was a read its pact declares", () => {
	assert.deepEqual(usage.fake.unmatched, [], "calls no pact declares");
	assert.ok(usage.fake.matched.length > 0, "no provider API was called");
});

Then("no token value is kept by the sync", () => {
	const kept = JSON.stringify([
		usage.outcomes,
		usage.sync.readings(ACCOUNT),
		usage.subscriptions,
	]);
	for (const token of usage.stored.values())
		assert.ok(!kept.includes(String(token)), "a token was kept");
	for (const header of usage.fake.authorizations)
		assert.match(header, /^Bearer (depot|namespace|warpbuild)-(usage|revoked)-token$/u);
});
