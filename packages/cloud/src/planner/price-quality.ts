/**
 * Whether a cost decision is worth claiming.
 *
 * ADR-0071 makes placement cost-aware and Plan 5 estimates at plan time. Both
 * rest on accurate multi-provider price data, and the design treated that data
 * as free. It is not: Infracost built a business on a Cloud Pricing API, and
 * Vantage publishes prices as a distribution strategy precisely because
 * assembling them is expensive.
 *
 * Resourcing that data — building, licensing, or consuming someone else's — is
 * a commercial decision. Scoping the *claim* to what HoBo can actually price is
 * an engineering one, and this module is that scoping expressed as something
 * that fails rather than as a paragraph in a design doc.
 *
 * ## The fault it addresses
 *
 * The catalog cannot currently distinguish an unpriced offering from a free
 * one, and that is not a cosmetic problem:
 *
 *   - `ResourceDefinition.cost.marginalPrice` is a bare decimal string. The
 *     `currency` that `CostSignal` carried is dropped on the way in, and no
 *     source or staleness travels with it.
 *   - Every default in the repo — `@hobo/sdk`, the local provider, the
 *     event-rehydration path — is `marginalPrice: "0"`.
 *   - The planner ranks by `Number.parseFloat(marginalPrice)`. So under
 *     `min-cost`, a provider that declared *nothing* scores zero and beats
 *     every provider that declared a real price. Silence wins the auction.
 *   - An unparseable price becomes `+Infinity` and quietly loses, so a typo in
 *     a manifest is indistinguishable from an expensive offering.
 *
 * ## The decision
 *
 * A price says what it is worth: `priced`, `unpriced`, or `unparseable`. A
 * cost-objective decision made over candidates that are not all priced is
 * **not claimable as cost-optimal** — the ranking still happens, because a
 * planner that refuses to place anything is worse than one that places without
 * boasting, but the claim is withheld and the unpriced candidates are named.
 *
 * A real zero stays expressible through `priceDeclared`, because a free tier
 * has to be modellable. The difference between a claim and a default is that
 * someone said it.
 */
import type { ResourceDefinition } from "../registry/catalog.js";

/**
 * - `priced` — a usable price someone actually declared.
 * - `unpriced` — no price was stated. Distinct from a price of zero.
 * - `unparseable` — a price was stated and cannot be read. A defect, not a gap.
 */
export type PriceQuality = "priced" | "unpriced" | "unparseable";

/** The cost record as the catalog carries it, plus the explicit-zero escape. */
export interface DeclaredCost {
	readonly sku: string;
	readonly unit: string;
	readonly marginalPrice: string;
	readonly pricingStatus?: "unknown" | "estimate" | "verified-zero";
	/**
	 * Set when a provider means the stated price literally, including zero.
	 * Without it a `"0"` is read as the repo-wide default, which is what it
	 * almost always is.
	 */
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
	/** Whether the outcome may be described as the cheapest option. */
	readonly claimable: boolean;
	/** Why not, when it may not be. */
	readonly reason?: CostClaimReason;
	/** Candidates that stated no price. Sorted. */
	readonly unpriced: readonly string[];
	/** Candidates whose stated price could not be read. Sorted. */
	readonly unparseable: readonly string[];
	/** The fraction of candidates that carried a usable price. */
	readonly coverage: number;
}

/** Objectives whose ranking rests on price. Spelled as the planner spells them. */
const COST_OBJECTIVES: ReadonlySet<string> = new Set(["cost", "min-cost"]);

export function classifyPriceQuality(cost: DeclaredCost): PriceQuality {
	if (cost.pricingStatus === "unknown") return "unpriced";
	const raw = cost.marginalPrice.trim();
	if (raw.length === 0) return "unpriced";

	if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(raw))
		return "unparseable";
	const value = Number(raw);
	// Not a number at all, or a number that cannot be a price. Either way a
	// human wrote something wrong, and folding it into "unpriced" would hide
	// the typo for as long as the manifest lives.
	if (!Number.isFinite(value) || value < 0) return "unparseable";
	if (cost.pricingStatus === "verified-zero" && value !== 0)
		return "unparseable";

	// The load-bearing line: a bare "0" is the repo-wide default, not an offer
	// of free compute — unless someone said they meant it.
	if (
		value === 0 &&
		cost.priceDeclared !== true &&
		cost.pricingStatus !== "verified-zero"
	)
		return "unpriced";
	return "priced";
}

/** Read the quality of a catalog definition's price. */
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

	// Ranking by latency does not rest on price, so an unpriced candidate is
	// not this verdict's business.
	if (!COST_OBJECTIVES.has(input.objective))
		return { claimable: true, unpriced, unparseable, coverage };

	// A malformed price is reported ahead of a missing one: one is a typo
	// somebody can fix today, the other is a data-coverage problem somebody has
	// to resource.
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
