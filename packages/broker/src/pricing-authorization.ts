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

export interface BillingAuthorizationInput {
	readonly spendEstimateUsd?: number;
	readonly quoteIncrementalUsd?: number;
	readonly quoteIncrementalDecimal?: string;
	readonly billing: BillingPolicy;
}

export interface BillingAuthorizationResult {
	readonly ok: boolean;
	readonly reasons: RejectionReason[];
	readonly authorizedUsd: number;
}

function resolveEstimateUsd(input: BillingAuthorizationInput): number {
	if (input.quoteIncrementalDecimal !== undefined) {
		const parsed = parseDecimal(input.quoteIncrementalDecimal);
		if (parsed === undefined) return Number.NaN;
		if (parsed.coefficient < 0n) return Number.NaN;
		return Number(input.quoteIncrementalDecimal);
	}
	return input.quoteIncrementalUsd ?? input.spendEstimateUsd ?? Number.NaN;
}

/**
 * Authorizes placement spend using a pricing quote when present, otherwise the
 * legacy spend estimate path.
 */
export function authorizeBillingSpend(
	input: BillingAuthorizationInput,
): BillingAuthorizationResult {
	const estimate = resolveEstimateUsd(input);
	if (!Number.isFinite(estimate) || estimate < 0) {
		return {
			ok: false,
			reasons: [
				{
					plane: "billing",
					code: "spend-estimate-invalid",
					message: "estimated spend must be a non-negative finite number",
				},
			],
			authorizedUsd: 0,
		};
	}
	const reasons: RejectionReason[] = [];
	if (input.billing.spendCapUsd > 0 && estimate > input.billing.spendCapUsd) {
		reasons.push({
			plane: "billing",
			code: "spend-cap-exceeded",
			message: `estimated spend ${estimate} USD exceeds per-resolution cap ${input.billing.spendCapUsd} USD`,
		});
	}
	if (input.billing.budgetUsd > 0 && estimate > input.billing.budgetUsd) {
		reasons.push({
			plane: "billing",
			code: "budget-exceeded",
			message: `estimated spend ${estimate} USD exceeds remaining budget ${input.billing.budgetUsd} USD`,
		});
	}
	return { ok: reasons.length === 0, reasons, authorizedUsd: estimate };
}

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
