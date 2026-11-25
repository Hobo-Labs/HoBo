import type { ResourceDefinition } from "../registry/catalog.js";

export type PriceQuality = "priced" | "unpriced" | "unparseable";

export interface DeclaredCost {
	readonly sku: string;
	readonly unit: string;
	readonly marginalPrice: string;
	readonly pricingStatus?: "unknown" | "estimate" | "verified-zero";
	readonly priceDeclared?: boolean;
}

export interface PricedCandidate {
	readonly id: string;
	readonly cost: DeclaredCost;
}

export type CostClaimReason =
	| "no-candidates"
	| "unpriced-candidates"
	| "unparseable-prices";

export interface CostObjectiveInput {
	readonly objective: string;
	readonly candidates: readonly PricedCandidate[];
}

export interface CostObjectiveVerdict {
	readonly claimable: boolean;
	readonly reason?: CostClaimReason;
	readonly unpriced: readonly string[];
	readonly unparseable: readonly string[];
	readonly coverage: number;
}

const COST_OBJECTIVES: ReadonlySet<string> = new Set(["cost", "min-cost"]);

export function classifyPriceQuality(cost: DeclaredCost): PriceQuality {
	if (cost.pricingStatus === "unknown") return "unpriced";
	const raw = cost.marginalPrice.trim();
	if (raw.length === 0) return "unpriced";

	if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(raw))
		return "unparseable";
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return "unparseable";
	if (cost.pricingStatus === "verified-zero" && value !== 0)
		return "unparseable";

	if (
		value === 0 &&
		cost.priceDeclared !== true &&
		cost.pricingStatus !== "verified-zero"
	)
		return "unpriced";
	return "priced";
}

export function definitionPriceQuality(
	definition: ResourceDefinition,
): PriceQuality {
	return classifyPriceQuality(definition.cost);
}

export function assessCostObjective(
	input: CostObjectiveInput,
): CostObjectiveVerdict {
	const unpriced: string[] = [];
	const unparseable: string[] = [];
	let priced = 0;

	for (const candidate of input.candidates) {
		const quality = classifyPriceQuality(candidate.cost);
		if (quality === "priced") priced += 1;
		else if (quality === "unpriced") unpriced.push(candidate.id);
		else unparseable.push(candidate.id);
	}

	unpriced.sort();
	unparseable.sort();

	const coverage =
		input.candidates.length === 0 ? 0 : priced / input.candidates.length;

	if (!COST_OBJECTIVES.has(input.objective))
		return { claimable: true, unpriced, unparseable, coverage };

	const reason: CostClaimReason | undefined =
		input.candidates.length === 0
			? "no-candidates"
			: unparseable.length > 0
				? "unparseable-prices"
				: unpriced.length > 0
					? "unpriced-candidates"
					: undefined;

	return {
		claimable: reason === undefined,
		...(reason === undefined ? undefined : { reason }),
		unpriced,
		unparseable,
		coverage,
	};
}
