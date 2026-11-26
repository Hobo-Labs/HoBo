/**
 * The relay's offers as provider manifests (ADR-0179 phase 5): every manifest
 * in `offers/` lowers into an `@hobo/pricing` catalog, the relay's default
 * cache offers are the ones derived from those catalogs, and the lifecycle
 * driver is chosen by a logged rule that never picks an unbuilt driver.
 */
import { readdir, readFile } from "node:fs/promises";
import { fromJson } from "@bufbuild/protobuf";
import { catalogHashOf, PricingCatalogSchema } from "@hobo/pricing";
import {
	parseProviderManifest,
	toPricingCatalog,
} from "@hobo/provider-manifest";
import { describe, expect, it } from "vitest";
import {
	RELAY_CACHE_OFFER_DEFAULTS,
	RELAY_OFFER_CATALOGS,
} from "../src/_generated-assets/relay-offers.js";
import { defaultCacheOffers, parseCacheOffers } from "../src/cache-offers.js";
import {
	chooseLifecycleDriver,
	LIFECYCLE_LEASE_DRIVER_PROFILE,
} from "../src/lifecycle-driver.js";

const offers = new URL("../offers/", import.meta.url);

describe("the relay's offer manifests", () => {
	it("each lowers into a pricing catalog, and the generated catalogs are that lowering", async () => {
		const files = (await readdir(offers))
			.filter((name) => name.endsWith(".provider.yaml"))
			.sort();
		expect(files).toEqual([
			"aiven-valkey.provider.yaml",
			"self-hosted-valkey.provider.yaml",
			"turso.provider.yaml",
			"upstash-redis.provider.yaml",
			"vercel-blob.provider.yaml",
			"vercel-queues.provider.yaml",
			"vercel-workflows.provider.yaml",
		]);
		for (const file of files) {
			const parsed = parseProviderManifest(
				await readFile(new URL(file, offers), "utf8"),
			);
			if (!parsed.ok) throw new Error(`${file} does not parse`);
			const lowered = toPricingCatalog(parsed.manifest);
			const generated = RELAY_OFFER_CATALOGS.find(
				(entry) => entry.manifest === `offers/${file}`,
			);
			expect(generated?.catalogHash).toBe(lowered?.catalog.catalogHash);
			// The stored catalog hashes to what it says.
			const catalog = fromJson(PricingCatalogSchema, generated?.catalog ?? {});
			expect(catalogHashOf(catalog)).toBe(generated?.catalogHash);
		}
	});

	it("declares the cache profile on every cache offer and the driver profile on every driver", () => {
		const profiles = Object.fromEntries(
			RELAY_OFFER_CATALOGS.map((entry) => [entry.providerId, entry.profiles]),
		);
		for (const provider of [
			"upstash",
			"aiven",
			"turso",
			"self-hosted-valkey",
			"vercel-blob",
		])
			expect(profiles[provider]).toContain("kv.ephemeral-state/v1");
		for (const provider of ["vercel-queues", "vercel-workflows"])
			expect(profiles[provider]).toContain(LIFECYCLE_LEASE_DRIVER_PROFILE);
	});
});

describe("default cache offers, from the catalog", () => {
	it("are the catalog's rate cards: free allowances blocked when spent, Blob metered with no cap", () => {
		const defaults = defaultCacheOffers();
		const upstash = defaults.get("upstash");
		expect(upstash?.tier).toBe("free");
		expect(upstash?.model.allowances).toEqual([
			expect.objectContaining({
				unit: "commands",
				included: 500_000,
				beyond: "hard-stop",
			}),
		]);
		expect(defaults.get("valkey")?.model.allowances).toEqual([]);
		expect(
			defaults.get("turso")?.model.allowances.map((entry) => entry.included),
		).toEqual([500_000_000, 10_000_000]);
		const blob = defaults.get("blob");
		expect(blob?.tier).toBe("payg");
		expect(blob?.capMicros).toBeUndefined();
		expect(blob?.model.allowances).toEqual([
			expect.objectContaining({ beyond: "metered", meteredMicrosPerUnit: 0.4 }),
			expect.objectContaining({ beyond: "metered", meteredMicrosPerUnit: 5 }),
		]);
		// Evidence names the manifest, and Blob's price says it is unverified.
		expect(blob?.model.evidence.source).toContain(
			"offers/vercel-blob.provider.yaml",
		);
		expect(blob?.model.evidence.source).toContain("UNVERIFIED");
		expect(defaults.has("redis")).toBe(false);
		expect(defaults.get("memory")?.tier).toBe("free");
	});

	it("keeps HOBO_CI_CACHE_MONTHLY_COMMANDS and HOBO_CI_CACHE_OFFERS_JSON as overrides", () => {
		expect(
			defaultCacheOffers(1000).get("upstash")?.model.allowances[0]?.included,
		).toBe(1000);
		const declared = parseCacheOffers(
			JSON.stringify({
				offers: [
					{
						backend: "blob",
						tier: "payg",
						plan: "pro",
						capMicros: 2_000_000,
						allowances: [
							{
								unit: "simple-operations",
								beyond: "metered",
								meteredMicrosPerUnit: 0.4,
							},
						],
						evidence: { source: "owner", observedAt: "2026-11-11" },
					},
				],
			}),
		);
		expect(declared.offers.get("blob")?.capMicros).toBe(2_000_000);
		expect(declared.offers.get("upstash")?.model.allowances[0]?.included).toBe(
			500_000,
		);
	});

	it("names one catalog rate card per cache backend", () => {
		expect(RELAY_CACHE_OFFER_DEFAULTS.map((entry) => entry.rateCardId)).toEqual(
			[
				"upstash/redis-free/free@2026.11.11",
				"aiven/valkey-free/free@2026.11.11",
				"turso/libsql-free/free@2026.11.11",
				"vercel-blob/blob-private/pay-as-you-go@2026.11.11",
			],
		);
	});
});

describe("the lifecycle driver choice", () => {
	it("chooses Vercel Queues and says why Workflows is not eligible", () => {
		expect(chooseLifecycleDriver("2026-11-11T12:00:00.000Z")).toEqual({
			driver: "queues",
			considered: [
				"queues: chosen (price unverified)",
				"workflows: not built; available from 2026-11-18",
			],
		});
	});

	it("still does not choose Workflows once its pin date passes, until the driver is built", () => {
		expect(chooseLifecycleDriver("2026-11-20").considered).toEqual([
			"queues: chosen (price unverified)",
			"workflows: not built",
		]);
	});
});
