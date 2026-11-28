import {
	DEFAULT_TRUST_POLICY,
	type TrustPolicy,
} from "@hobo/capability-profiles";

import { isWideningKind, type WideningKind } from "./widening.js";

export type RecipePolicyInput = {
	readonly trust?: TrustPolicy;
	readonly maximumProviderCount: number;
	readonly maximumClaimActions: number;
	readonly maximumSponsoredCostMinorUnits: number;
	readonly minimumClaimWindowMs: number;
	readonly maximumEvidenceAgeMs: number;
	readonly allowedWidenings?: readonly WideningKind[];
	readonly requireSourceDisclosure?: boolean;
};

const recipePolicyBrand: unique symbol = Symbol("RecipePolicy");

export type RecipePolicy = {
	readonly trust: TrustPolicy;
	readonly maximumProviderCount: number;
	readonly maximumClaimActions: number;
	readonly maximumSponsoredCostMinorUnits: number;
	readonly minimumClaimWindowMs: number;
	readonly maximumEvidenceAgeMs: number;
	readonly allowedWidenings: readonly WideningKind[];
	readonly requireSourceDisclosure: boolean;
	readonly [recipePolicyBrand]: "RecipePolicy";
};

export class RecipePolicyError extends Error {
	readonly code = "INVALID_RECIPE_POLICY" as const;

	constructor(message: string) {
		super(message);
		this.name = "RecipePolicyError";
	}
}

function requireNonNegativeInteger(value: number, field: string): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new RecipePolicyError(`${field} must be a non-negative integer`);
	}
	return value;
}

export function parseRecipePolicy(input: RecipePolicyInput): RecipePolicy {
	if (
		!Number.isInteger(input.maximumProviderCount) ||
		input.maximumProviderCount < 1
	) {
		throw new RecipePolicyError(
			"maximumProviderCount must be a positive integer",
		);
	}
	requireNonNegativeInteger(input.maximumClaimActions, "maximumClaimActions");
	requireNonNegativeInteger(
		input.maximumSponsoredCostMinorUnits,
		"maximumSponsoredCostMinorUnits",
	);
	requireNonNegativeInteger(input.minimumClaimWindowMs, "minimumClaimWindowMs");
	if (
		!Number.isInteger(input.maximumEvidenceAgeMs) ||
		input.maximumEvidenceAgeMs <= 0
	) {
		throw new RecipePolicyError(
			"maximumEvidenceAgeMs must be a positive integer",
		);
	}
	const widenings = [...(input.allowedWidenings ?? [])];
	for (const kind of widenings) {
		if (!isWideningKind(kind)) {
			throw new RecipePolicyError(
				`unknown widening kind ${JSON.stringify(kind)}`,
			);
		}
	}

	return {
		trust: input.trust ?? DEFAULT_TRUST_POLICY,
		maximumProviderCount: input.maximumProviderCount,
		maximumClaimActions: input.maximumClaimActions,
		maximumSponsoredCostMinorUnits: input.maximumSponsoredCostMinorUnits,
		minimumClaimWindowMs: input.minimumClaimWindowMs,
		maximumEvidenceAgeMs: input.maximumEvidenceAgeMs,
		allowedWidenings: [...new Set(widenings)].sort((a, b) =>
			a.localeCompare(b),
		),
		requireSourceDisclosure: input.requireSourceDisclosure ?? true,
		[recipePolicyBrand]: "RecipePolicy",
	};
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_RECIPE_POLICY: RecipePolicy = parseRecipePolicy({
	maximumProviderCount: 2,
	maximumClaimActions: 2,
	maximumSponsoredCostMinorUnits: 0,
	minimumClaimWindowMs: HOUR_MS,
	maximumEvidenceAgeMs: 30 * DAY_MS,
});
