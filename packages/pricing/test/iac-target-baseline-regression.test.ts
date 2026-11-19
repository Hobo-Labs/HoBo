import { clone, create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ChargeComponentSchema,
	MeterDefinitionSchema,
	ProviderAgreementSchema,
	ProviderProductSchema,
	QuantitySchema,
	RateCardSchema,
	UsageMeasurementSchema,
	WorkloadDeltaSchema,
} from "../src/_generated/pricing_pb.js";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
} from "../src/target-pricing.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

const digest = `sha256:${"a".repeat(64)}`;

function scenario() {
	return makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
}

function inventory() {
	return createTargetPricingInventory({
		targetId: "target-a",
		tenantId: "tenant-a",
		planDigest: digest,
		complete: true,
		evidenceRef: "inventory:attested",
		resources: [
			{
				resourceId: "stack/compute",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
		],
	});
}

describe("baseline pricing evidence", () => {
	it("rejects a baseline product absent from the target inventory", () => {
		const joint = scenario();
		const catalog = joint.catalog;
		const state = joint.state;
		const sourceCard = catalog?.rateCards[0];
		const sourceAgreement = state?.agreements[0];
		const candidate = joint.candidate[0];
		if (
			catalog === undefined ||
			state === undefined ||
			sourceCard === undefined ||
			sourceAgreement === undefined ||
			candidate === undefined
		) {
			throw new Error("fixture scenario incomplete");
		}
		const sandboxProduct = catalog.products[0];
		if (sandboxProduct === undefined)
			throw new Error("fixture product missing");
		const databaseProduct = clone(ProviderProductSchema, sandboxProduct);
		databaseProduct.id = "database";
		databaseProduct.meters = [
			create(MeterDefinitionSchema, {
				dimension: "gb",
				unit: "gb",
				aggregation: "sum",
			}),
		];
		catalog.products.push(databaseProduct);
		const dbCard = clone(RateCardSchema, sourceCard);
		dbCard.id = "card-db";
		dbCard.charges = [
			create(ChargeComponentSchema, {
				base: {
					id: "storage",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				variant: {
					case: "usage",
					value: {
						dimension: "gb",
						timing: "arrears",
						price: {
							case: "perUnit",
							value: { decimal: "0.10", currency: "USD" },
						},
					},
				},
			}),
		];
		catalog.rateCards.push(dbCard);
		const dbAgreement = clone(ProviderAgreementSchema, sourceAgreement);
		dbAgreement.id = "agreement-db";
		dbAgreement.productId = "database";
		for (const entry of dbAgreement.rateSchedule) entry.rateCardId = "card-db";
		state.agreements.push(dbAgreement);
		const baseline = clone(WorkloadDeltaSchema, candidate);
		baseline.productRef = "database";
		baseline.agreementRef = "agreement-db";
		const measurement = candidate.usage[0];
		if (measurement === undefined)
			throw new Error("fixture measurement missing");
		const gbUsage = clone(UsageMeasurementSchema, measurement);
		gbUsage.dimension = "gb";
		gbUsage.quantity = create(QuantitySchema, { decimal: "10", unit: "gb" });
		baseline.usage = [gbUsage];
		joint.baseline.push(baseline);
		rehashScenario(joint);
		const model = targetPricingModel({
			modelId: "customer-terms",
			revision: "1",
			planDigest: digest,
			scenario: joint,
			bindings: [{ resourceId: "stack/compute", candidateIndex: 0 }],
		});
		expect(quoteTargetPricing(inventory(), model)).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_SCOPE_MISMATCH",
		});
	});
});
