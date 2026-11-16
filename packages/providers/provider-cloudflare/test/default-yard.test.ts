import { describe, expect, it } from "vitest";

import {
	CLOUDFLARE_D1_PRODUCT_ID,
	CLOUDFLARE_DEFAULT_BINDINGS,
	CLOUDFLARE_DEFAULT_REGIONS,
	CLOUDFLARE_DEFAULT_YARD_NAME,
	CLOUDFLARE_KV_PRODUCT_ID,
	CLOUDFLARE_PAGES_PRODUCT_ID,
	CLOUDFLARE_QUEUES_PRODUCT_ID,
	CLOUDFLARE_R2_PRODUCT_ID,
	CLOUDFLARE_WORKERS_PRODUCT_ID,
	cloudflareResolverRegistry,
	cloudflareYard,
	cloudflareYardSpec,
} from "../src/index.js";

function registry() {
	return cloudflareResolverRegistry({
		accountId: "acct-1234",
		resolveCredential: () => Promise.resolve("token"),
	});
}

describe("the default Cloudflare Yard is a catalog of what CAN be allocated", () => {
	it("offers every slot the slot factories emit", () => {
		expect(Object.keys(cloudflareYard().offerings).sort()).toEqual([
			"bucket",
			"data",
			"kv",
			"queue",
			"service",
			"web",
		]);
	});

	it("lists SEVERAL options for a slot Cloudflare can serve more than one way", () => {
		const web = cloudflareYard().offerings.web ?? [];
		expect(web.map((binding) => binding.productId).sort()).toEqual([
			CLOUDFLARE_PAGES_PRODUCT_ID,
			CLOUDFLARE_WORKERS_PRODUCT_ID,
		]);
	});

	it("explicitly exposes only the default HTTP Worker offering", () => {
		const yard = cloudflareYard();
		expect(
			yard.offerings.web?.find(
				(binding) => binding.productId === CLOUDFLARE_WORKERS_PRODUCT_ID,
			)?.properties.workersDev,
		).toBe(true);
		expect(
			yard.offerings.service?.find(
				(binding) => binding.productId === CLOUDFLARE_WORKERS_PRODUCT_ID,
			)?.properties.workersDev,
		).toBeUndefined();
	});

	it("keeps every web option on the web capability profile", () => {
		for (const binding of cloudflareYard().offerings.web ?? []) {
			expect(binding.slot).toBe("web");
			expect(binding.profile).toBe("web.hosted/v1");
		}
	});

	it.each([
		["bucket", CLOUDFLARE_R2_PRODUCT_ID],
		["data", CLOUDFLARE_D1_PRODUCT_ID],
		["kv", CLOUDFLARE_KV_PRODUCT_ID],
		["queue", CLOUDFLARE_QUEUES_PRODUCT_ID],
		["service", CLOUDFLARE_WORKERS_PRODUCT_ID],
	] as const)("offers %s via %s", (slot, productId) => {
		const options = cloudflareYard().offerings[slot] ?? [];
		expect(options.map((binding) => binding.productId)).toEqual([productId]);
	});

	it("is a catalog, not a choice: no slot is pruned to one option to look tidy", () => {
		const counts = Object.values(cloudflareYard().offerings).map(
			(options) => options.length,
		);
		expect(Math.max(...counts)).toBeGreaterThan(1);
	});
});

describe("the catalog compiles into YardBindingInput-shaped rows", () => {
	it("emits one row per offering", () => {
		const offered = Object.values(cloudflareYard().offerings).reduce(
			(total, options) => total + options.length,
			0,
		);
		expect(CLOUDFLARE_DEFAULT_BINDINGS).toHaveLength(offered);
	});

	it("carries only profile, productId, and properties on each row", () => {
		for (const row of CLOUDFLARE_DEFAULT_BINDINGS) {
			expect(Object.keys(row).sort()).toEqual([
				"productId",
				"profile",
				"properties",
			]);
		}
	});

	it("has a resolver registered for every row's productId", () => {
		const resolvers = registry();
		for (const row of CLOUDFLARE_DEFAULT_BINDINGS) {
			expect(resolvers.get(row.productId)?.productId).toBe(row.productId);
		}
	});

	it("keeps two distinct rows for the two web options", () => {
		const webRows = CLOUDFLARE_DEFAULT_BINDINGS.filter(
			(row) => row.profile === "web.hosted/v1",
		);
		expect(webRows.map((row) => row.productId)).toEqual([
			CLOUDFLARE_PAGES_PRODUCT_ID,
			CLOUDFLARE_WORKERS_PRODUCT_ID,
		]);
	});

	it("holds no duplicate (profile, productId) pair", () => {
		const pairs = CLOUDFLARE_DEFAULT_BINDINGS.map(
			(row) => `${row.profile}|${row.productId}`,
		);
		expect(new Set(pairs).size).toBe(pairs.length);
	});

	it("sorts rows by profile then product so the set is canonical", () => {
		const keys = CLOUDFLARE_DEFAULT_BINDINGS.map(
			(row) => `${row.profile}|${row.productId}`,
		);
		expect(keys).toEqual([...keys].sort());
	});

	it("is frozen, so a consumer cannot mutate the shared catalog", () => {
		expect(Object.isFrozen(CLOUDFLARE_DEFAULT_BINDINGS)).toBe(true);
		for (const row of CLOUDFLARE_DEFAULT_BINDINGS) {
			expect(Object.isFrozen(row)).toBe(true);
		}
	});

	it("declares no credential-shaped property on any row", () => {
		for (const row of CLOUDFLARE_DEFAULT_BINDINGS) {
			for (const key of Object.keys(row.properties)) {
				expect(key).not.toMatch(/secret|token|password|credential|key/iu);
			}
		}
	});
});

describe("yard metadata", () => {
	it("defaults to the global Cloudflare edge and the provider name", () => {
		const yard = cloudflareYard();
		expect(yard.name).toBe(CLOUDFLARE_DEFAULT_YARD_NAME);
		expect(yard.provider).toBe("cloudflare");
		expect(yard.regions).toEqual([...CLOUDFLARE_DEFAULT_REGIONS]);
	});

	it("accepts a name and canonicalizes regions", () => {
		const yard = cloudflareYard({
			name: "edge-prod",
			regions: ["weur", "enam", "weur"],
		});
		expect(yard.name).toBe("edge-prod");
		expect(yard.regions).toEqual(["enam", "weur"]);
	});

	it("returns the same catalog for the same options", () => {
		expect(cloudflareYard({ name: "a" })).toEqual(
			cloudflareYard({ name: "a" }),
		);
	});

	it.each([
		[[""], "a blank region would silently widen residency"],
		[["  "], "a whitespace region names nothing"],
	])("refuses regions %j", (regions) => {
		expect(() => cloudflareYard({ regions })).toThrow(/regions/u);
	});

	it("refuses a blank yard name", () => {
		expect(() => cloudflareYard({ name: " " })).toThrow(/name/u);
	});

	it("exposes exactly provider, regions, and bindings on the yards spec", () => {
		const spec = cloudflareYardSpec({ regions: ["weur"] });
		expect(Object.keys(spec).sort()).toEqual([
			"bindings",
			"provider",
			"regions",
		]);
		expect(spec.provider).toBe("cloudflare");
		expect(spec.regions).toEqual(["weur"]);
		expect(spec.bindings).toBe(CLOUDFLARE_DEFAULT_BINDINGS);
	});
});
