import { parseManifest } from "@hobo/bindles";
import { describe, expect, it } from "vitest";
import { matchResource } from "../src/planner/matching.js";
import { plan } from "../src/planner/plan.js";
import { classifyPriceQuality } from "../src/planner/price-quality.js";
import {
	createRegistryFromProviders,
	definitionsFor,
	parseRegisteredDefinitions,
	type RegistrableProvider,
	registerProviderFact,
} from "../src/registry/catalog.js";

function provider(
	id: string,
	options: {
		region?: string;
		unit?: string;
		pricingStatus?: "unknown" | "estimate" | "verified-zero";
		productId?: string;
	} = {},
): RegistrableProvider {
	return {
		id,
		regions: [options.region ?? "us"],
		capabilities: [
			{
				port: "compute",
				satisfies: () => ({ kind: "full" }),
				estimateCost: () => ({
					sku: id,
					unit: options.unit ?? "hour",
					marginalPrice: "0",
					pricingStatus: options.pricingStatus,
				}),
			},
		],
		capabilityManifest: () => ({
			providerId: id,
			published: {},
			capabilities: {
				capabilities: [
					{
						port: "compute",
						features: ["http"],
						...(options.productId
							? { productId: options.productId }
							: undefined),
					},
				],
			},
			cost: { facts: [] },
		}),
	};
}
describe("production catalog price provenance", () => {
	it("pins an explicit native product through registration, replay and the actual planner", () => {
		const native = provider("netlify", {
			productId: "netlify.static-deploy/v1",
		});
		const registry = createRegistryFromProviders([native]);
		expect(registry.catalogHash).not.toBe(
			createRegistryFromProviders([provider("netlify")]).catalogHash,
		);
		const event = registerProviderFact(native);
		expect(parseRegisteredDefinitions(event.data)[0]?.productId).toBe(
			"netlify.static-deploy/v1",
		);
		const manifest = parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasm", version: "1" },
			resources: {
				app: {
					type: "component.v1",
					image: "oci://example/app",
					runtime: "wasm",
					exports: ["wasi:http/incoming-handler"],
				},
			},
		});
		const result = plan(manifest, { deploymentId: "deploy" }, registry);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("explicit product planning failed");
		expect(result.plan.resources[0]?.productId).toBe(
			"netlify.static-deploy/v1",
		);
		expect(result.decisions[0]?.productId).toBe("netlify.static-deploy/v1");
	});
	it("pins units, provider regions and price provenance into the catalog identity", () => {
		const digest = (input: RegistrableProvider) =>
			createRegistryFromProviders([input]).catalogHash;
		const baseline = digest(provider("a"));
		for (const changed of [
			provider("a", { region: "eu" }),
			provider("a", { unit: "month" }),
			provider("a", { pricingStatus: "unknown" }),
		])
			expect(digest(changed)).not.toBe(baseline);
	});
	it("preserves an explicit unknown instead of presenting zero as a price", () => {
		const definition = definitionsFor(
			provider("a", { pricingStatus: "unknown" }),
		)[0];
		expect(definition.cost.pricingStatus).toBe("unknown");
		expect(classifyPriceQuality(definition.cost)).toBe("unpriced");
		expect(
			classifyPriceQuality({
				...definition.cost,
				pricingStatus: "verified-zero",
			}),
		).toBe("priced");
	});
	it("keeps unknown-price ordering deterministic in both registry orders", () => {
		const intent = {
			name: "api",
			port: "compute",
			require: ["http"],
			prefer: [],
			negotiation: "require" as const,
			objective: "min-cost",
		};
		const a = provider("a", { pricingStatus: "unknown" }),
			b = provider("b", { pricingStatus: "unknown" });
		const first = matchResource(intent, createRegistryFromProviders([b, a]));
		const second = matchResource(intent, createRegistryFromProviders([a, b]));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok && second.ok) expect(first.decision).toEqual(second.decision);
	});
	it("rejects trailing currency/unit text as a malformed numeric hint", () => {
		for (const marginalPrice of [
			"1 USD",
			"0.01/hour",
			"5garbage",
			"0x10",
			"0b10",
		])
			expect(
				classifyPriceQuality({
					sku: "a",
					unit: "hour",
					marginalPrice,
					pricingStatus: "estimate",
				}),
			).toBe("unparseable");
	});
	it("refuses a nonzero price mislabeled as verified zero", () => {
		expect(
			classifyPriceQuality({
				sku: "a",
				unit: "hour",
				marginalPrice: "1",
				pricingStatus: "verified-zero",
			}),
		).toBe("unparseable");
	});
});
