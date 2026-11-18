import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
	ActualChargeObservedSchema,
	ActualChargeSchema,
	ExternalProviderQuoteSchema,
	ProviderAgreementSchema,
	ReconciliationRecordedSchema,
} from "../src/_generated/pricing_pb.js";
import { rejectExternalProviderQuote } from "../src/external-quote.js";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function ratingScenario(agreementRef = "agreement-a") {
	return makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload(agreementRef, [usage("minute", "1", "minute")])],
	});
}

it("denies new provider agreements unless explicitly allowed", () => {
	const scenario = ratingScenario("agreement-b");
	const source = scenario.state?.agreements[0];
	if (source === undefined || scenario.options === undefined) {
		throw new Error("missing agreement fixture");
	}
	const agreement = clone(ProviderAgreementSchema, source);
	agreement.id = "agreement-b";
	agreement.status = "trialing";
	scenario.state?.agreements.push(agreement);
	rehashScenario(scenario);

	expect(quoteScenario(scenario)).toMatchObject({
		code: "NEW_AGREEMENT_DENIED",
	});
	scenario.options.allowNewProviderAgreement = true;
	expect(isQuoteVector(quoteScenario(scenario))).toBe(true);
});

it("excludes customer commerce concepts from provider pricing schemas", () => {
	const providerPricingFields = [
		...ProviderAgreementSchema.fields,
		...ExternalProviderQuoteSchema.fields,
	].map((field) => field.localName);

	expect(providerPricingFields).not.toContainEqual(
		expect.stringMatching(
			/customer|subscription|invoice|checkout|payment|refund|dunning|tax|revenue/i,
		),
	);
});

it("legacy CI translators remain separate from CreditAccount fields", () => {
	const translator = readFileSync(
		join(import.meta.dirname, "../src/legacy/sandbox-pricing.ts"),
		"utf8",
	);
	const dispatcher = readFileSync(
		join(import.meta.dirname, "../../dispatcher/src/dispatcher.ts"),
		"utf8",
	);
	const accountStart = dispatcher.indexOf("export interface CreditAccount {");
	const accountEnd = dispatcher.indexOf("\n}", accountStart);
	const creditAccount = dispatcher.slice(accountStart, accountEnd);

	expect(accountStart).toBeGreaterThanOrEqual(0);
	expect(accountEnd).toBeGreaterThan(accountStart);
	expect(translator).not.toContain("CreditAccount");
	expect(creditAccount).not.toMatch(
		/effectiveCost|subscription|commitment|tenantId/,
	);
});

it("external persisted quotes never become executable rating", () => {
	const external = create(ExternalProviderQuoteSchema, {
		id: "provider-quote-1",
		providerAccountRef: "account-a",
		productId: "sandbox",
	});

	expect(rejectExternalProviderQuote(external)).toMatchObject({
		code: "PRICING_MODEL_UNSUPPORTED",
		message: expect.stringContaining("not an executable rating model"),
		unpriced: [
			expect.objectContaining({
				agreementRef: "account-a",
				chargeId: "provider-quote-1",
			}),
		],
	});
});

it("denies cancellation unless explicitly allowed", () => {
	const scenario = ratingScenario();
	scenario.action = "cancel";
	if (scenario.options === undefined) throw new Error("missing quote options");

	expect(quoteScenario(scenario)).toMatchObject({
		code: "CANCELLATION_DENIED",
	});
	scenario.options.allowCancellation = true;
	expect(isQuoteVector(quoteScenario(scenario))).toBe(true);
});

it("reconciliation events require provider id dedupe keys", () => {
	expect(
		ActualChargeSchema.fields.find((field) => field.localName === "id")?.number,
	).toBe(1);
	expect(
		ActualChargeObservedSchema.fields.find(
			(field) => field.localName === "actualCharge",
		)?.number,
	).toBe(3);
	expect(
		ReconciliationRecordedSchema.fields.find(
			(field) => field.localName === "actualCharges",
		)?.number,
	).toBe(4);
});

it("keeps provider-price rating deterministic and offline", () => {
	const first = quoteScenario(ratingScenario());
	const second = quoteScenario(ratingScenario());
	const quoteSource = readFileSync(
		join(import.meta.dirname, "../src/quote.ts"),
		"utf8",
	);

	expect(first).toEqual(second);
	expect(quoteSource).not.toMatch(
		/\b(?:fetch|XMLHttpRequest|WebSocket|node:https?|axios)\b/,
	);
	expect(
		rejectExternalProviderQuote(
			create(ExternalProviderQuoteSchema, {
				id: "persisted-evidence",
				providerAccountRef: "account-a",
				productId: "sandbox",
			}),
		),
	).toMatchObject({ code: "PRICING_MODEL_UNSUPPORTED" });
});
