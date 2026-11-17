import type { QuoteVector } from "@hobo/pricing";

export function hasDispatchEligibility(quote: QuoteVector): boolean {
	return quote.eligibility?.eligible === true && quote.unpriced.length === 0;
}
