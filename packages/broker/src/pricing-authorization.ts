import { clone } from "@bufbuild/protobuf";
import {
	compareDecimal,
	type Decimal,
	formatDecimal,
	parseDecimal,
	type QuoteVector,
	QuoteVectorSchema,
	quoteHashOf,
	RATING_ALGORITHM_VERSION,
} from "@hobo/pricing";

import {
	billingBounds,
	decimalFromNumber,
	upperNumber,
} from "./billing-decimal.js";
import { isJsonString } from "./json.js";
import type { BillingPolicy, RejectionReason } from "./types.js";

export interface TrustedQuoteAttestation {
	readonly liabilityBoundUsd: string;
}

export interface BillingAuthorizationInput {
	readonly spendEstimateUsd?: number;
	readonly quoteIncrementalUsd?: number;
	readonly quoteIncrementalDecimal?: string;
	readonly quote?: QuoteVector;
	readonly attestQuote?: (
		quote: QuoteVector,
	) => TrustedQuoteAttestation | undefined;
	readonly trustEstimate?: boolean;
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

export function authorizeBillingSpend(
	input: BillingAuthorizationInput,
): BillingAuthorizationResult {
	const billing = { ...input.billing };
	let estimate: Decimal | undefined;
	if (input.quote !== undefined) {
		let quote: QuoteVector;
		let quoted: Decimal | undefined;
		try {
			quote = clone(QuoteVectorSchema, input.quote);
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
			quoted = parseDecimal(billed.decimal);
		} catch {
			return reject("quote-invalid", "quote content is invalid");
		}
		if (quoted === undefined || quoted.coefficient < 0n)
			return reject(
				"spend-estimate-invalid",
				"estimated spend must be a non-negative finite amount",
			);
		if (!input.attestQuote)
			return reject(
				"quote-provenance-required",
				"a trusted authority must authenticate and bind the quote",
			);
		const expectedHash = quote.quoteHash;
		let attestation: TrustedQuoteAttestation | undefined;
		try {
			attestation = input.attestQuote(quote);
			const bound = attestation?.liabilityBoundUsd;
			if (
				!attestation ||
				quote.quoteHash !== expectedHash ||
				quoteHashOf(quote) !== expectedHash
			)
				return reject(
					"quote-provenance-invalid",
					"quote attestation failed or changed its contents",
				);
			estimate = isJsonString(bound) ? parseDecimal(bound) : undefined;
		} catch {
			return reject(
				"quote-provenance-invalid",
				"quote attestation failed or changed its contents",
			);
		}
		if (
			estimate === undefined ||
			estimate.coefficient < 0n ||
			compareDecimal(estimate, quoted) < 0
		)
			return reject(
				"quote-bound-invalid",
				"attested liability must cover the quoted amount",
			);
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
		if (estimate !== undefined && input.trustEstimate !== true)
			return reject(
				"estimate-untrusted",
				"raw spend estimates require explicit host trust",
			);
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
	const bounds = billingBounds(billing);
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
			message: `estimated spend ${formatDecimal(estimate)} USD exceeds per-resolution cap ${billing.spendCapUsd} USD`,
		});
	if (budget !== undefined && compareDecimal(estimate, budget) > 0)
		reasons.push({
			plane: "billing",
			code: "budget-exceeded",
			message: `estimated spend ${formatDecimal(estimate)} USD exceeds remaining budget ${billing.budgetUsd} USD`,
		});
	return {
		ok: reasons.length === 0,
		reasons,
		authorizedUsd: reasons.length === 0 ? authorized : 0,
	};
}
