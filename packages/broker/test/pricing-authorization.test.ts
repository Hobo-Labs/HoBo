import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import {
	isQuoteVector,
	parseQuoteScenario,
	QuoteEngine,
	QuoteVectorSchema,
	quoteHashOf,
	RATING_ALGORITHM_VERSION,
	stateHashOf,
	UnpricedItemSchema,
} from "@hobo/pricing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	authorizeBillingSpend as authorizeWithAuthority,
	type BillingAuthorizationInput,
} from "../src/pricing-authorization.js";

function authorizeBillingSpend(input: BillingAuthorizationInput) {
	return authorizeWithAuthority({
		...input,
		trustEstimate: true,
		attestQuote: (quote) => ({
			liabilityBoundUsd: quote.incremental?.billed?.decimal ?? "",
		}),
	});
}

const policy = {
	quota: "default",
	quotaUsed: 0,
	quotaLimit: 1000,
	budgetUsd: 50,
	spendCapUsd: 40,
};
function quote(decimal: string, currency = "USD") {
	const result = create(QuoteVectorSchema, {
		schema: "hobo.pricing.quote/v1",
		ratingAlgorithmVersion: RATING_ALGORITHM_VERSION,
		incremental: { billed: { decimal, currency } },
		eligibility: { eligible: true },
	});
	result.quoteHash = quoteHashOf(result);
	return result;
}

describe("authorizeBillingSpend", () => {
	it("prefers quote incremental over legacy spend estimate", () => {
		const result = authorizeBillingSpend({
			quote: quote("5.25"),
			spendEstimateUsd: 100,
			quoteIncrementalUsd: 99,
			quoteIncrementalDecimal: "100",
			billing: policy,
		});
		expect(result).toMatchObject({ ok: true, authorizedUsd: 5.25 });
	});

	it.each([
		{ quoteIncrementalUsd: 5 },
		{ quoteIncrementalDecimal: "5" },
	])("requires a full quote for a raw quote amount", (input) => {
		const result = authorizeBillingSpend({ ...input, billing: policy });
		expect(result).toMatchObject({
			ok: false,
			authorizedUsd: 0,
			reasons: [{ code: "quote-evidence-required" }],
		});
	});

	it("rejects negative quote incremental decimal", () => {
		const result = authorizeBillingSpend({
			quote: quote("-0.01"),
			billing: policy,
		});
		expect(result).toMatchObject({
			ok: false,
			authorizedUsd: 0,
			reasons: [{ code: "spend-estimate-invalid" }],
		});
	});

	it("rejects an ineligible or incompletely priced quote", () => {
		const ineligible = quote("1");
		if (!ineligible.eligibility) throw new Error("missing eligibility");
		ineligible.eligibility.eligible = false;
		ineligible.quoteHash = quoteHashOf(ineligible);
		expect(
			authorizeBillingSpend({ quote: ineligible, billing: policy }).reasons[0]
				?.code,
		).toBe("quote-ineligible");
		const unpriced = quote("1");
		unpriced.unpriced.push(
			create(UnpricedItemSchema, {
				productRef: "p",
				agreementRef: "a",
				chargeId: "c",
				reason: "missing",
			}),
		);
		unpriced.quoteHash = quoteHashOf(unpriced);
		expect(
			authorizeBillingSpend({ quote: unpriced, billing: policy }).reasons[0]
				?.code,
		).toBe("quote-ineligible");
		const missing = quote("1");
		missing.eligibility = undefined;
		missing.quoteHash = quoteHashOf(missing);
		expect(
			authorizeBillingSpend({ quote: missing, billing: policy }).reasons[0]
				?.code,
		).toBe("quote-ineligible");
	});

	it("rejects modified, old-version, and non-USD quotes", () => {
		const changed = quote("1");
		if (!changed.incremental?.billed) throw new Error("missing amount");
		changed.incremental.billed.decimal = "0";
		expect(
			authorizeBillingSpend({ quote: changed, billing: policy }).reasons[0]
				?.code,
		).toBe("quote-invalid");
		const foreign = quote("1");
		foreign.ratingAlgorithmVersion = "external-rating";
		foreign.quoteHash = quoteHashOf(foreign);
		expect(
			authorizeBillingSpend({ quote: foreign, billing: policy }).reasons[0]
				?.code,
		).toBe("quote-invalid");
		expect(
			authorizeBillingSpend({ quote: quote("1", "EUR"), billing: policy })
				.reasons[0]?.code,
		).toBe("quote-invalid");
	});

	it("rejects a genuine partial showback quote", () => {
		const corpus = JSON.parse(
			readFileSync(
				new URL(
					"../../pricing/corpus/golden-replay-baseline.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const scenario = parseQuoteScenario(corpus.entries[0].scenario);
		if (!scenario?.state || !scenario.options)
			throw new Error("missing scenario");
		scenario.state.completeness = "partial";
		scenario.options.allowPartialFinancialState = true;
		scenario.state.stateHash = stateHashOf(scenario.state);
		const partial = QuoteEngine.quote(scenario);
		if (!isQuoteVector(partial)) throw new Error("partial showback rejected");
		expect(
			authorizeBillingSpend({ quote: partial, billing: policy }).reasons[0]
				?.code,
		).toBe("quote-ineligible");
	});

	it("accepts an eligible current quote from the pricing engine", () => {
		const corpus = JSON.parse(
			readFileSync(
				new URL(
					"../../pricing/corpus/golden-replay-baseline.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const scenario = parseQuoteScenario(corpus.entries[0].scenario);
		if (!scenario) throw new Error("missing scenario");
		const result = QuoteEngine.quote(scenario);
		if (!isQuoteVector(result)) throw new Error("complete quote rejected");
		expect(
			authorizeBillingSpend({ quote: result, billing: policy }),
		).toMatchObject({ ok: true, authorizedUsd: 0.5 });
	});

	it("enforces zero bounds unless unlimited mode is explicit", () => {
		const bounded = { ...policy, budgetUsd: 0, spendCapUsd: 0 };
		const denied = authorizeBillingSpend({
			spendEstimateUsd: 1,
			billing: bounded,
		});
		expect(denied).toMatchObject({ ok: false, authorizedUsd: 0 });
		expect(denied.reasons.map((reason) => reason.code)).toEqual([
			"spend-cap-exceeded",
			"budget-exceeded",
		]);
		expect(
			authorizeBillingSpend({
				spendEstimateUsd: 1,
				billing: { ...bounded, budgetUnlimited: true, spendCapUnlimited: true },
			}),
		).toMatchObject({ ok: true, authorizedUsd: 1 });
		const capOnly = authorizeBillingSpend({
			spendEstimateUsd: 1,
			billing: { ...bounded, spendCapUnlimited: true },
		});
		expect(capOnly.reasons.map((reason) => reason.code)).toEqual([
			"budget-exceeded",
		]);
		const budgetOnly = authorizeBillingSpend({
			spendEstimateUsd: 1,
			billing: { ...bounded, budgetUnlimited: true },
		});
		expect(budgetOnly.reasons.map((reason) => reason.code)).toEqual([
			"spend-cap-exceeded",
		]);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-1,
	])("rejects invalid bounded policy %s", (invalid) => {
		const result = authorizeBillingSpend({
			spendEstimateUsd: 1,
			billing: { ...policy, budgetUsd: invalid },
		});
		expect(result).toMatchObject({
			ok: false,
			authorizedUsd: 0,
			reasons: [{ code: "billing-policy-invalid" }],
		});
		const invalidCap = authorizeBillingSpend({
			spendEstimateUsd: 1,
			billing: { ...policy, spendCapUsd: invalid },
		});
		expect(invalidCap).toMatchObject({
			ok: false,
			authorizedUsd: 0,
			reasons: [{ code: "billing-policy-invalid" }],
		});
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-1,
	])("rejects invalid legacy spend estimate %s", (invalid) => {
		const result = authorizeBillingSpend({
			spendEstimateUsd: invalid,
			billing: policy,
		});
		expect(result).toMatchObject({
			ok: false,
			authorizedUsd: 0,
			reasons: [{ code: "spend-estimate-invalid" }],
		});
	});

	it("compares the exact quote before converting it to a number", () => {
		const billing = { ...policy, budgetUsd: 0.3, spendCapUsd: 0.3 };
		const result = authorizeBillingSpend({
			quote: quote("0.30000000000000001"),
			billing,
		});
		expect(result).toMatchObject({ ok: false, authorizedUsd: 0 });
		expect(result.reasons.map((reason) => reason.code)).toEqual([
			"spend-cap-exceeded",
			"budget-exceeded",
		]);
	});

	it("rounds an accepted exact liability upward for the number result", () => {
		const result = authorizeBillingSpend({
			quote: quote("1.00000000000000001"),
			billing: policy,
		});
		expect(result.ok).toBe(true);
		expect(result.authorizedUsd).toBeGreaterThan(1);
	});

	it("handles number-valued limits in exponent notation", () => {
		const billing = { ...policy, budgetUsd: 1e-7, spendCapUsd: 1e-7 };
		expect(
			authorizeBillingSpend({ quote: quote("0.0000001"), billing }).ok,
		).toBe(true);
		expect(
			authorizeBillingSpend({
				quote: quote("0.000000100000000000000001"),
				billing,
			}).ok,
		).toBe(false);
	});

	it("never authorizes generated exact amounts just above their decimal cap", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 100_000 }), (cents) => {
				const cap = cents / 100;
				const whole = Math.floor(cents / 100);
				const fractional = String(cents % 100).padStart(2, "0");
				const amount = `${whole}.${fractional}0000000000000001`;
				const result = authorizeBillingSpend({
					quote: quote(amount),
					billing: { ...policy, budgetUsd: cap, spendCapUsd: cap },
				});
				expect(result.ok).toBe(false);
			}),
			{ seed: 614493, numRuns: 300 },
		);
	});
});
