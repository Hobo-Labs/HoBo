export * from "./_generated/pricing_pb.js";

import type { PricingRejected, QuoteVector } from "./_generated/pricing_pb.js";

export type QuoteResult = QuoteVector | PricingRejected;

export type PricingRejectionCode =
	| "INVALID_PRICING_INPUT"
	| "INCOMPLETE_FINANCIAL_STATE"
	| "STALE_OBSERVATION"
	| "CATALOG_HASH_MISMATCH"
	| "STATE_HASH_MISMATCH"
	| "UNKNOWN_AGREEMENT"
	| "NEW_AGREEMENT_DENIED"
	| "CANCELLATION_DENIED"
	| "RATE_CARD_NOT_FOUND"
	| "AMBIGUOUS_EXCLUSIVE_GROUP"
	| "MISSING_EXCLUSIVE_FALLBACK"
	| "CROSS_CURRENCY"
	| "UNIT_CONVERSION_UNSUPPORTED"
	| "PRICING_MODEL_UNSUPPORTED"
	| "USAGE_LIMIT_EXCEEDED";

export function isQuoteVector(result: QuoteResult): result is QuoteVector {
	return result.$typeName === "hobo.pricing.v1.QuoteVector";
}

export function isPricingRejected(
	result: QuoteResult,
): result is PricingRejected {
	return result.$typeName === "hobo.pricing.v1.PricingRejected";
}
