import {
	compareDecimal,
	DECIMAL_ZERO,
	type Decimal,
	parseDecimal,
	type QuoteVector,
	quoteVectorToJson,
	stableHash,
} from "@hobo/pricing";
import type { BillingPlaneV2 } from "./planes.js";
import type { BillingPolicy, RejectionReason } from "./types.js";

type BillingResult = ReturnType<BillingPlaneV2["authorize"]>;

function quoteAuthorizationFailed(message: string): BillingResult {
	return {
		ok: false,
		reasons: [
			{
				plane: "billing",
				code: "quote-authorization-failed",
				message,
			},
		],
	};
}

function capReasons(
	billed: Decimal,
	billedText: string,
	billing: BillingPolicy,
): RejectionReason[] | undefined {
	const reasons: RejectionReason[] = [];
	if (billing.spendCapUsd > 0) {
		const cap = parseDecimal(String(billing.spendCapUsd));
		if (cap === undefined) return undefined;
		if (compareDecimal(billed, cap) > 0) {
			reasons.push({
				plane: "billing",
				code: "spend-cap-exceeded",
				message: `quoted spend ${billedText} USD exceeds per-resolution cap ${billing.spendCapUsd} USD`,
			});
		}
	}
	if (billing.budgetUsd > 0) {
		const budget = parseDecimal(String(billing.budgetUsd));
		if (budget === undefined) return undefined;
		if (compareDecimal(billed, budget) > 0) {
			reasons.push({
				plane: "billing",
				code: "budget-exceeded",
				message: `quoted spend ${billedText} USD exceeds remaining budget ${billing.budgetUsd} USD`,
			});
		}
	}
	return reasons;
}

export function createPricingBillingPlaneV2(
	quotes: readonly QuoteVector[],
): BillingPlaneV2 {
	return {
		authorize({ quoteHash, pricingCatalogHash, billing }) {
			const quote = quotes.find(
				(candidate) => candidate.quoteHash === quoteHash,
			);
			if (quote === undefined) {
				return quoteAuthorizationFailed(
					`quote ${quoteHash} is not present in the authorized quote set`,
				);
			}
			if (quote.pricingCatalogHash !== pricingCatalogHash) {
				return quoteAuthorizationFailed(
					`quote ${quoteHash} does not match pricing catalog ${pricingCatalogHash}`,
				);
			}
			const recomputedHash = stableHash(
				quoteVectorToJson({ ...quote, quoteHash: "" }),
			);
			if (recomputedHash !== quoteHash) {
				return quoteAuthorizationFailed(
					`quote ${quoteHash} fails content-hash verification`,
				);
			}
			if (quote.eligibility?.eligible !== true || quote.unpriced.length > 0) {
				return quoteAuthorizationFailed(
					`quote ${quoteHash} is not eligible and completely priced`,
				);
			}
			const billed = quote.incremental?.billed;
			if (billed === undefined || billed.currency !== "USD") {
				return quoteAuthorizationFailed(
					`quote ${quoteHash} must contain incremental billed USD`,
				);
			}
			const amount = parseDecimal(billed.decimal);
			if (amount === undefined || compareDecimal(amount, DECIMAL_ZERO) < 0) {
				return quoteAuthorizationFailed(
					`quote ${quoteHash} incremental billed USD must be a complete non-negative decimal`,
				);
			}
			const reasons = capReasons(amount, billed.decimal, billing);
			if (reasons === undefined) {
				return quoteAuthorizationFailed(
					"billing limits must be finite decimal values",
				);
			}
			return { ok: reasons.length === 0, reasons };
		},
	};
}
