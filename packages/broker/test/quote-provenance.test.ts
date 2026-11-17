import { generateKeyPairSync, sign, verify } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	QuoteVectorSchema,
	quoteHashOf,
	RATING_ALGORITHM_VERSION,
} from "@hobo/pricing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authorizeBillingSpend } from "../src/pricing-authorization.js";
import { rejectionMatrixRow } from "../src/rejections.js";

const billing = {
	quota: "q",
	quotaUsed: 0,
	quotaLimit: 1,
	budgetUsd: 10,
	spendCapUsd: 10,
};
function quote(amount: string) {
	const value = create(QuoteVectorSchema, {
		schema: "hobo.pricing.quote/v1",
		ratingAlgorithmVersion: RATING_ALGORITHM_VERSION,
		incremental: { billed: { decimal: amount, currency: "USD" } },
		eligibility: { eligible: true },
	});
	value.quoteHash = quoteHashOf(value);
	return value;
}

describe("trusted quote provenance and liability", () => {
	it("does not authorize a self-hashed quote without an independent authority", () => {
		expect(authorizeBillingSpend({ quote: quote("0"), billing })).toMatchObject(
			{ ok: false, reasons: [{ code: "quote-provenance-required" }] },
		);
	});

	it("requires explicit trust before using a raw legacy estimate", () => {
		expect(
			authorizeBillingSpend({ spendEstimateUsd: 0, billing }),
		).toMatchObject({ ok: false, reasons: [{ code: "estimate-untrusted" }] });
		expect(
			authorizeBillingSpend({
				spendEstimateUsd: 0,
				billing,
				trustEstimate: true,
			}).ok,
		).toBe(true);
	});

	it("uses a signed, request-bound liability instead of the quote's expected bill", () => {
		const key = generateKeyPairSync("ed25519");
		const current = quote("1");
		const context = {
			quoteHash: current.quoteHash,
			request: "request-a",
			bound: "4.25",
			expires: 100,
		};
		const bytes = Buffer.from(JSON.stringify(context));
		const signature = sign(null, bytes, key.privateKey);
		const authority =
			(expectedRequest: string, now: number) => (candidate: typeof current) =>
				candidate.quoteHash === context.quoteHash &&
				expectedRequest === context.request &&
				now < context.expires &&
				verify(null, bytes, key.publicKey, signature)
					? { liabilityBoundUsd: context.bound }
					: undefined;
		expect(
			authorizeBillingSpend({
				quote: current,
				billing,
				attestQuote: authority("request-a", 99),
			}),
		).toMatchObject({ ok: true, authorizedUsd: 4.25 });
		expect(
			authorizeBillingSpend({
				quote: current,
				billing,
				attestQuote: authority("request-b", 99),
			}),
		).toMatchObject({
			ok: false,
			reasons: [{ code: "quote-provenance-invalid" }],
		});
		expect(
			authorizeBillingSpend({
				quote: current,
				billing,
				attestQuote: authority("request-a", 100),
			}),
		).toMatchObject({
			ok: false,
			reasons: [{ code: "quote-provenance-invalid" }],
		});
		const forged = sign(null, bytes, generateKeyPairSync("ed25519").privateKey);
		expect(
			authorizeBillingSpend({
				quote: current,
				billing,
				attestQuote: () =>
					verify(null, bytes, key.publicKey, forged)
						? { liabilityBoundUsd: context.bound }
						: undefined,
			}),
		).toMatchObject({
			ok: false,
			reasons: [{ code: "quote-provenance-invalid" }],
		});
	});

	it("refuses absent, insufficient, invalid or over-budget attested liability", () => {
		const current = quote("5");
		for (const bound of ["4.99", "-1", "not-a-decimal"]) {
			expect(
				authorizeBillingSpend({
					quote: current,
					billing,
					attestQuote: () => ({ liabilityBoundUsd: bound }),
				}),
			).toMatchObject({
				ok: false,
				reasons: [{ code: "quote-bound-invalid" }],
			});
		}
		expect(
			authorizeBillingSpend({
				quote: current,
				billing,
				attestQuote: () => undefined,
			}),
		).toMatchObject({
			ok: false,
			reasons: [{ code: "quote-provenance-invalid" }],
		});
		expect(
			authorizeBillingSpend({
				quote: current,
				billing,
				attestQuote: () => ({ liabilityBoundUsd: "10.0000000001" }),
			}).ok,
		).toBe(false);
	});

	it("catalogs every quote and estimate rejection for remediation", () => {
		for (const code of [
			"quote-invalid",
			"quote-ineligible",
			"quote-evidence-required",
			"quote-provenance-required",
			"quote-provenance-invalid",
			"quote-bound-invalid",
			"estimate-untrusted",
			"spend-estimate-invalid",
		]) {
			expect(rejectionMatrixRow(code)).toMatchObject({
				code,
				plane: "billing",
			});
			expect(rejectionMatrixRow(code)?.remediation).toBeTruthy();
		}
	});

	it("never authorizes less than a generated attested liability", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000 }),
				fc.integer({ min: 0, max: 1_000 }),
				fc.integer({ min: 0, max: 2_000 }),
				(quotedCents, extraCents, capCents) => {
					const amount = (quotedCents / 100).toFixed(2);
					const bound = ((quotedCents + extraCents) / 100).toFixed(2);
					const cap = capCents / 100;
					const result = authorizeBillingSpend({
						quote: quote(amount),
						billing: { ...billing, budgetUsd: cap, spendCapUsd: cap },
						attestQuote: () => ({ liabilityBoundUsd: bound }),
					});
					expect(result.ok).toBe(quotedCents + extraCents <= capCents);
					if (result.ok)
						expect(result.authorizedUsd).toBeGreaterThanOrEqual(
							(quotedCents + extraCents) / 100,
						);
				},
			),
			{ seed: 614515, numRuns: 500 },
		);
	});

	it("binds the budget policy before invoking the quote authority", () => {
		const mutable = { ...billing, budgetUsd: 1, spendCapUsd: 1 };
		const result = authorizeBillingSpend({
			quote: quote("0"),
			billing: mutable,
			attestQuote: () => {
				mutable.budgetUsd = 100;
				mutable.spendCapUsd = 100;
				return { liabilityBoundUsd: "5" };
			},
		});
		expect(result.ok).toBe(false);
		expect(result.reasons.map((reason) => reason.code)).toEqual([
			"spend-cap-exceeded",
			"budget-exceeded",
		]);
	});

	it("refuses quote mutation from an attestation getter", () => {
		const result = authorizeBillingSpend({
			quote: quote("5"),
			billing,
			attestQuote: (candidate) => ({
				get liabilityBoundUsd() {
					if (!candidate.incremental?.billed) throw new Error("fixture");
					candidate.incremental.billed.decimal = "0";
					candidate.quoteHash = quoteHashOf(candidate);
					return "0";
				},
			}),
		});
		expect(result).toMatchObject({
			ok: false,
			reasons: [{ code: "quote-provenance-invalid" }],
		});
	});

	it("refuses authority exceptions and mutations of the quote during verification", () => {
		const current = quote("5");
		expect(
			authorizeBillingSpend({
				quote: current,
				billing,
				attestQuote: () => {
					throw new Error("unavailable");
				},
			}),
		).toMatchObject({
			ok: false,
			reasons: [{ code: "quote-provenance-invalid" }],
		});
		expect(
			authorizeBillingSpend({
				quote: current,
				billing,
				attestQuote: (candidate) => {
					if (!candidate.incremental?.billed) throw new Error("fixture");
					candidate.incremental.billed.decimal = "0";
					candidate.quoteHash = quoteHashOf(candidate);
					return { liabilityBoundUsd: "0" };
				},
			}),
		).toMatchObject({
			ok: false,
			reasons: [{ code: "quote-provenance-invalid" }],
		});
		expect(current.incremental?.billed?.decimal).toBe("5");
	});
});
