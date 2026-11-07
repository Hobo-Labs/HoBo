import { parseDecimal } from "@hobo/pricing";

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
	return {
		ok: reasons.length === 0,
		reasons,
		authorizedUsd: estimate,
	};
}
