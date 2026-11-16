import { toJson } from "@bufbuild/protobuf";
import { catalogHashOf, PricingCatalogSchema } from "@hobo/pricing";
import { describe, expect, it } from "vitest";
import { toPricingCatalog } from "../src/index.js";
import { example, mustParse } from "./support/example.js";
import { billed } from "./support/quote.js";

function lowering() {
	const lowered = toPricingCatalog(example());
	if (lowered === undefined) throw new Error("example has billing");
	return lowered;
}

describe("toPricingCatalog", () => {
	it("returns undefined for a manifest with no billing section", () => {
		const manifest = mustParse(`
schema: hobo.provider-manifest/v1
provider: { id: keyless, displayName: Keyless }
auth:
  issuer: https://auth.example.com
  flows:
    - id: federation
      oidcFederation: { audience: hobo }
`);
		expect(toPricingCatalog(manifest)).toBeUndefined();
	});

	it("namespaces products by provider and derives meters from billables", () => {
		const { catalog } = lowering();
		expect(catalog.products.map((product) => product.id)).toEqual([
			"acme-cloud/gpu-a1",
			"acme-cloud/pg-flex",
			"acme-cloud/llm-large",
			"acme-cloud/print-farm",
		]);
		const llm = catalog.products[2];
		expect(llm?.meters.map((meter) => [meter.dimension, meter.unit])).toEqual([
			["input-tokens", "token"],
			["output-tokens", "token"],
			["seat", "seat"],
			["workload", "workload"],
		]);
		const filament = catalog.products[3]?.meters[0];
		expect(filament?.rounding?.multiple).toBe("0.25");
	});

	it("pins a catalog hash the pricing kernel reproduces", () => {
		const { catalog } = lowering();
		expect(catalog.catalogHash).toBe(catalogHashOf(catalog));
		expect(catalog.catalogHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it("is deterministic", () => {
		const encode = () =>
			JSON.stringify(toJson(PricingCatalogSchema, lowering().catalog));
		expect(encode()).toBe(encode());
	});

	it("gives an unrateable plan no rate card instead of a partial one", () => {
		const lowered = lowering();
		expect(lowered.unrated).toEqual([
			{
				productId: "llm-large",
				planId: "spot",
				chargeId: "auction",
				model: "x-spot-auction",
				reason: "PRICING_MODEL_UNSUPPORTED",
			},
		]);
		expect(
			lowered.catalog.rateCards.some((card) => card.id.includes("/spot@")),
		).toBe(false);
		expect(() => billed(lowered, "llm-large", "spot")).toThrow("unrated");
	});

	it("reports included usage as declared facts, not tenant grants", () => {
		const lowered = lowering();
		expect(lowered.included).toEqual([
			{
				productId: "pg-flex",
				planId: "standard",
				billable: "storage",
				quantity: "10",
				unit: "GB",
				reset: "none",
			},
			{
				productId: "llm-large",
				planId: "team-monthly",
				billable: "input-tokens",
				quantity: "50000000",
				unit: "token",
				reset: "monthly",
			},
		]);
		expect(lowered.catalog.allowances).toEqual([]);
	});
});

// Each billing model the manifest can express, rated by the real kernel.
describe("lowered catalogs rate through @hobo/pricing", () => {
	it("hardware, metered: 2.5 GPU-hours at 1.80/hour", () => {
		expect(
			billed(lowering(), "gpu-a1", "on-demand", {
				"gpu-time": ["9000", "second"],
			}),
		).toBe("4.5");
	});

	it("hardware, metered: converts hours of usage to the metered unit", () => {
		expect(
			billed(lowering(), "gpu-a1", "on-demand", {
				"gpu-time": ["2", "hour"],
			}),
		).toBe("3.6");
	});

	it("hardware, monthly: two reserved instances", () => {
		expect(
			billed(lowering(), "gpu-a1", "reserved-monthly", {}, { instance: "2" }),
		).toBe("1800");
	});

	it("service: flat monthly fee plus graduated storage", () => {
		// 25 + (10 free) + (40 * 0.12)
		expect(
			billed(lowering(), "pg-flex", "standard", { storage: ["50", "GB"] }),
		).toBe("29.8");
	});

	it("ai, token pricing: per-million rates are pro-rata", () => {
		// 1.5M input * 3.00 + 0.2M output * 15.00
		expect(
			billed(lowering(), "llm-large", "pay-as-you-go", {
				"input-tokens": ["1500000", "token"],
				"output-tokens": ["200000", "token"],
			}),
		).toBe("7.5");
	});

	it("ai, price per workload", () => {
		expect(
			billed(lowering(), "llm-large", "batch", {
				workload: ["12", "workload"],
			}),
		).toBe("4.8");
	});

	it("ai, monthly seats plus token overage", () => {
		expect(
			billed(
				lowering(),
				"llm-large",
				"team-monthly",
				{ "input-tokens": ["4000000", "token"] },
				{ seat: "3" },
			),
		).toBe("100");
	});

	it("materials: whole packages round partial usage up", () => {
		// 0.6 kg -> 3 quarter-kilogram spools
		expect(
			billed(lowering(), "print-farm", "per-spool", {
				filament: ["0.6", "kg"],
			}),
		).toBe("18");
	});
});
