import { describe, expect, it } from "vitest";
import {
	DepotUsageReader,
	NamespaceUsageReader,
	PROVIDER_USAGE_TIMEOUT_MS,
	type ProviderUsageReader,
	WarpbuildUsageReader,
} from "../src/provider-usage/index.js";
import {
	loadUsagePact,
	USAGE_PACT_ORIGINS,
	type UsagePactProvider,
	usagePactFake,
} from "../test/support/provider-usage-pact.js";

const NOW = Date.UTC(2026, 10, 17, 12);
const WINDOW = { startMs: Date.UTC(2026, 10, 1), endMs: NOW };

function reader(
	provider: UsagePactProvider,
	fetchImpl: typeof fetch,
): ProviderUsageReader {
	const http = { fetch: fetchImpl, timeoutMs: PROVIDER_USAGE_TIMEOUT_MS };
	if (provider === "depot")
		return new DepotUsageReader({
			...http,
			baseUrl: USAGE_PACT_ORIGINS.depot,
		});
	if (provider === "namespace")
		return new NamespaceUsageReader({
			...http,
			originOf: (region) =>
				USAGE_PACT_ORIGINS.namespace.replace("us.", `${region}.`),
		});
	return new WarpbuildUsageReader({
		...http,
		baseUrl: USAGE_PACT_ORIGINS.warpbuild,
	});
}

const CASES: ReadonlyArray<
	Readonly<{
		provider: UsagePactProvider;
		token: string;
		revoked: string;
		region: string | undefined;
		usd: number;
	}>
> = [
	{
		provider: "depot",
		token: "depot-usage-token",
		revoked: "depot-revoked-token",
		region: undefined,
		usd: 123.45,
	},
	{
		provider: "namespace",
		token: "namespace-usage-token",
		revoked: "namespace-revoked-token",
		region: "us",
		usd: 60,
	},
	{
		provider: "warpbuild",
		token: "warpbuild-usage-token",
		revoked: "warpbuild-revoked-token",
		region: undefined,
		usd: 42.5,
	},
];

describe.each(CASES)("the $provider usage pact", (entry) => {
	it("is read through every declared interaction", async () => {
		const pact = loadUsagePact(entry.provider);
		expect(pact.interactions).toHaveLength(2);
		const fake = usagePactFake(new Map([[entry.provider, pact]]));
		const usage = reader(entry.provider, fake.fetch);

		// This month's spend, in US dollars.
		expect(
			await usage.spentUsd({
				window: WINDOW,
				token: entry.token,
				region: entry.region,
			}),
		).toBeCloseTo(entry.usd, 6);
		// A refused token is unmeasured, never a throw and never zero.
		expect(
			await usage.spentUsd({
				window: WINDOW,
				token: entry.revoked,
				region: entry.region,
			}),
		).toBeUndefined();

		expect(fake.unmatched).toEqual([]);
		expect(fake.matched).toEqual(
			pact.interactions.map(
				(interaction) => `${entry.provider}: ${interaction.description}`,
			),
		);
	});

	it("names only read procedures", () => {
		for (const interaction of loadUsagePact(entry.provider).interactions)
			expect(interaction.request.path).toMatch(
				/\/(?:GetGithubActionsUsageProjection|GetUsage|reports\/billing\/ci)$/u,
			);
	});
});
