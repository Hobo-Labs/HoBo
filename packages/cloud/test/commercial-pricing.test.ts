import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { PricingCatalogSchema } from "@hobo/pricing";
import { describe, it } from "vitest";
import {
	capabilityCatalogHash,
	commercialProductRefs,
	pricingCatalogHash,
} from "../src/commercial-pricing.js";
import {
	parseRegisteredDefinitions,
	type ResourceDefinition,
} from "../src/registry/catalog.js";

const definition: ResourceDefinition = {
	id: "provider:hobo:data",
	providerId: "provider",
	port: "hobo:data",
	features: ["transactions"],
	regions: ["us-east-1"],
	specificity: 10,
	priority: 0,
	cost: { sku: "data", unit: "GB", marginalPrice: "0.1" },
	commercialProductRefs: ["postgres", "postgres-ha", "postgres"],
	satisfies: () => ({ kind: "full" }),
};

describe("commercial pricing catalog hashes", () => {
	it("maps sorted unique product refs without using them as a pricing hash", () => {
		assert.deepEqual(commercialProductRefs([definition]), {
			"provider:hobo:data": ["postgres", "postgres-ha"],
		});

		const catalog = create(PricingCatalogSchema, {
			schema: "hobo.pricing.catalog/v1",
			products: [{ id: "postgres", providerId: "provider", meters: [] }],
			rateCards: [{ id: "card-v1", version: "1", currency: "USD" }],
		});
		const initial = pricingCatalogHash(catalog);
		const rateCard = catalog.rateCards[0];
		assert.ok(rateCard);
		rateCard.version = "2";
		assert.notEqual(pricingCatalogHash(catalog), initial);
		assert.deepEqual(commercialProductRefs([definition]), {
			"provider:hobo:data": ["postgres", "postgres-ha"],
		});
	});

	it("hashes versioned capability content independently of definition order", () => {
		const other = { ...definition, id: "provider:hobo:bucket", port: "hobo:bucket" };
		const first = capabilityCatalogHash([definition, other]);
		assert.equal(first, capabilityCatalogHash([other, definition]));
		assert.notEqual(
			first,
			capabilityCatalogHash([
				{ ...definition, commercialProductRefs: ["different-product"] },
				other,
			]),
		);
		assert.match(first, /^sha256:[a-f0-9]{64}$/u);
	});

	it("preserves commercial refs through registered-definition replay", () => {
		const parsed = parseRegisteredDefinitions({
			providerId: definition.providerId,
			definitions: [
				{
					id: definition.id,
					port: definition.port,
					features: definition.features,
					regions: definition.regions,
					specificity: definition.specificity,
					priority: definition.priority,
					cost: definition.cost,
					commercialProductRefs: definition.commercialProductRefs,
				},
			],
		});
		assert.deepEqual(parsed[0]?.commercialProductRefs, [
			"postgres",
			"postgres-ha",
			"postgres",
		]);
	});
});
