import {
	compareDecimal,
	type Decimal,
	formatDecimal,
	parseDecimal,
	type QuoteVector,
	quoteHashOf,
	RATING_ALGORITHM_VERSION,
} from "@hobo/pricing";

import {
	billingBounds,
	decimalFromNumber,
	upperNumber,
} from "./billing-decimal.js";
import type { BillingPolicy, RejectionReason } from "./types.js";

export interface BillingAuthorizationInput {
	readonly spendEstimateUsd?: number;
	/** Legacy quote amounts require the complete quote as evidence. */
	readonly quoteIncrementalUsd?: number;
	readonly quoteIncrementalDecimal?: string;
	readonly quote?: QuoteVector;
	readonly billing: BillingPolicy;
}

export interface BillingAuthorizationResult {
	readonly ok: boolean;
	readonly reasons: RejectionReason[];
	readonly authorizedUsd: number;
}

function reject(code: string, message: string): BillingAuthorizationResult {
	return {
		ok: false,
		reasons: [{ plane: "billing", code, message }],
		authorizedUsd: 0,
	};
}

/**
 * Authorizes a complete, eligible current quote or a trusted legacy estimate.
 * A quote hash detects changed contents; it does not authenticate the provider.
 */
export function authorizeBillingSpend(
	input: BillingAuthorizationInput,
): BillingAuthorizationResult {
	let estimate: Decimal | undefined;
	if (input.quote !== undefined) {
		const quote = input.quote;
		try {
			if (
				quote.schema !== "hobo.pricing.quote/v1" ||
				quote.ratingAlgorithmVersion !== RATING_ALGORITHM_VERSION ||
				quote.quoteHash !== quoteHashOf(quote)
			)
				return reject(
					"quote-invalid",
					"quote version or content hash is invalid",
				);
			if (quote.eligibility?.eligible !== true || quote.unpriced.length > 0)
				return reject(
					"quote-ineligible",
					"quote is not eligible for automatic selection",
				);
			const billed = quote.incremental?.billed;
			if (billed?.currency !== "USD")
				return reject(
					"quote-invalid",
					"quote incremental billed amount must be USD",
				);
			estimate = parseDecimal(billed.decimal);
		} catch {
			return reject("quote-invalid", "quote content is invalid");
		}
	} else {
		if (
			input.quoteIncrementalDecimal !== undefined ||
			input.quoteIncrementalUsd !== undefined
		)
			return reject(
				"quote-evidence-required",
				"a complete quote is required for quote-based authorization",
			);
		if (input.spendEstimateUsd !== undefined)
			estimate = decimalFromNumber(input.spendEstimateUsd);
	}
	if (estimate === undefined || estimate.coefficient < 0n)
		return reject(
			"spend-estimate-invalid",
			"estimated spend must be a non-negative finite amount",
		);
	const authorized = upperNumber(estimate);
	if (authorized === undefined)
		return reject(
			"spend-estimate-invalid",
			"estimated spend cannot be represented safely",
		);
	const bounds = billingBounds(input.billing);
	if (bounds === undefined)
		return reject(
			"billing-policy-invalid",
			"bounded budget and spend cap must be finite and non-negative",
		);
	const { cap, budget } = bounds;
	const reasons: RejectionReason[] = [];
	if (cap !== undefined && compareDecimal(estimate, cap) > 0)
		reasons.push({
			plane: "billing",
			code: "spend-cap-exceeded",
			message: `estimated spend ${formatDecimal(estimate)} USD exceeds per-resolution cap ${input.billing.spendCapUsd} USD`,
		});
	if (budget !== undefined && compareDecimal(estimate, budget) > 0)
		reasons.push({
			plane: "billing",
			code: "budget-exceeded",
			message: `estimated spend ${formatDecimal(estimate)} USD exceeds remaining budget ${input.billing.budgetUsd} USD`,
		});
	return {
		ok: reasons.length === 0,
		reasons,
		authorizedUsd: reasons.length === 0 ? authorized : 0,
	};
}
