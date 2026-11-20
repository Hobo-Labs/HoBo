import {
	type BudgetRoutingDisclosure,
	compareDecimal,
	isQuoteVector,
	type Money,
	type PricingAvailability,
	parseDecimal,
	QuoteEngine,
	type QuoteScenario,
	type QuoteVector,
	quoteAvailablePricing,
} from "@hobo/pricing";

// public-contract: consumers pin the dispatcher v2 wire schema by this id.
export const DISPATCHER_V2_SCHEMA_VERSION = "hobo.dispatcher/v2";
// public-contract: v2 ranks candidates by incremental billed cost only.
export const DISPATCHER_V2_OBJECTIVE = "min-incremental-billed" as const;

export type DispatchCategoryV2 = "runner" | "build-machine" | "traffic-backend";
export type DispatchCostQuote = Omit<QuoteVector, "allocatedEffective">;
export type DispatchBudgetDisclosure = Readonly<
	Omit<BudgetRoutingDisclosure, "$typeName" | "evaluation" | "reservation"> & {
		evaluation: "not-evaluated";
		reservation: "not-created";
	}
>;

const BUDGET_DISCLOSURE: DispatchBudgetDisclosure = Object.freeze({
	evaluation: "not-evaluated",
	reservation: "not-created",
});

export type DispatchCandidateV2 = { providerId: string } & (
	| { scenario: QuoteScenario; pricing?: never }
	| { pricing: PricingAvailability; scenario?: never }
);

export interface DispatchRequestV2 {
	dispatchId: string;
	category: DispatchCategoryV2;
	objective?: typeof DISPATCHER_V2_OBJECTIVE;
	candidates: readonly DispatchCandidateV2[];
}

export interface DispatchRejectionV2 {
	providerId: string;
	code: string;
	reason: string;
}

export interface DispatchRankingV2 {
	providerId: string;
	rank: number;
	incrementalBilled: Money;
	quote: DispatchCostQuote;
	pricingModel?: {
		source: "developer-supplied";
		modelId: string;
		revision: string;
	};
}

export type DispatchDecisionV2 =
	| {
			ok: true;
			schema: typeof DISPATCHER_V2_SCHEMA_VERSION;
			objective: typeof DISPATCHER_V2_OBJECTIVE;
			budget: DispatchBudgetDisclosure;
			selectedProvider: string;
			ranking: DispatchRankingV2[];
			rejectedCandidates: DispatchRejectionV2[];
			dispatchEvent: {
				type: "dispatch.Decided";
				data: {
					dispatchId: string;
					category: DispatchCategoryV2;
					schema: typeof DISPATCHER_V2_SCHEMA_VERSION;
					objective: typeof DISPATCHER_V2_OBJECTIVE;
					budget: DispatchBudgetDisclosure;
					selectedProvider: string;
					ranking: DispatchRankingV2[];
					rejectedCandidates: DispatchRejectionV2[];
				};
			};
	  }
	| {
			ok: false;
			schema: typeof DISPATCHER_V2_SCHEMA_VERSION;
			objective: typeof DISPATCHER_V2_OBJECTIVE;
			budget: DispatchBudgetDisclosure;
			reason: string;
			ranking: [];
			rejectedCandidates: DispatchRejectionV2[];
	  };

function withoutAllocatedEffective(quote: QuoteVector): DispatchCostQuote {
	const { allocatedEffective: _advisory, ...dispatchQuote } = quote;
	return dispatchQuote;
}

function wasteScore(quote: QuoteVector): number {
	let total = 0n;
	for (const waste of quote.projectedWaste) {
		const amount = waste.amount?.value;
		if (amount?.case === "money" && amount.value?.decimal !== undefined) {
			const parsed = parseDecimal(amount.value.decimal);
			if (parsed !== undefined) total += parsed.coefficient;
		}
	}
	return total === 0n ? 0 : Number(total);
}

function earliestExpiryMs(quote: QuoteVector): number {
	let earliest = Number.POSITIVE_INFINITY;
	for (const waste of quote.projectedWaste) {
		const end = waste.bucketEnd;
		if (end.length === 0) continue;
		const parsed = Date.parse(end);
		if (Number.isFinite(parsed) && parsed < earliest) earliest = parsed;
	}
	return earliest;
}

function reject(
	candidate: DispatchCandidateV2,
	code: string,
	reason: string,
): DispatchRejectionV2 {
	return { providerId: candidate.providerId, code, reason };
}

export function decideDispatchV2(
	request: DispatchRequestV2,
): DispatchDecisionV2 {
	if (
		request.objective !== undefined &&
		request.objective !== DISPATCHER_V2_OBJECTIVE
	) {
		throw new TypeError("objective must be min-incremental-billed");
	}
	if (request.dispatchId.length === 0) {
		throw new TypeError("dispatchId must be a non-empty string");
	}
	const objective = DISPATCHER_V2_OBJECTIVE;
	const candidates = [...request.candidates].sort((left, right) =>
		left.providerId.localeCompare(right.providerId),
	);
	if (
		new Set(candidates.map((candidate) => candidate.providerId)).size !==
		candidates.length
	) {
		throw new TypeError("candidate providerId values must be unique");
	}
	if (candidates.some((candidate) => candidate.providerId.length === 0)) {
		throw new TypeError("candidate providerId must be a non-empty string");
	}

	const rejectedCandidates: DispatchRejectionV2[] = [];
	const priced: {
		candidate: DispatchCandidateV2;
		quote: QuoteVector;
		incrementalBilled: Money;
		pricingModel?: DispatchRankingV2["pricingModel"];
	}[] = [];
	for (const candidate of candidates) {
		if (candidate.pricing !== undefined && candidate.scenario !== undefined) {
			rejectedCandidates.push(
				reject(
					candidate,
					"PRICING_MODEL_INVALID",
					"declare one pricing source",
				),
			);
			continue;
		}
		let result: ReturnType<typeof QuoteEngine.quote>;
		let pricingModel: DispatchRankingV2["pricingModel"];
		if (candidate.pricing !== undefined) {
			const available = quoteAvailablePricing(
				candidate.providerId,
				candidate.pricing,
			);
			if (available.ok === false) {
				rejectedCandidates.push(
					reject(candidate, available.code, available.reason),
				);
				continue;
			}
			result = available.quote;
			pricingModel = {
				source: available.source,
				modelId: available.modelId,
				revision: available.revision,
			};
		} else if (candidate.scenario !== undefined) {
			if (
				candidate.scenario.state?.completeness !== "complete" ||
				candidate.scenario.options?.allowPartialFinancialState
			) {
				rejectedCandidates.push(
					reject(
						candidate,
						"INCOMPLETE_FINANCIAL_STATE",
						"a complete financial state is required for routing",
					),
				);
				continue;
			}
			result = QuoteEngine.quote(candidate.scenario);
		} else {
			rejectedCandidates.push(
				reject(
					candidate,
					"PRICING_MODEL_UNAVAILABLE",
					"pricing availability was not declared",
				),
			);
			continue;
		}
		if (!isQuoteVector(result)) {
			rejectedCandidates.push(reject(candidate, result.code, result.message));
			continue;
		}
		const billed = result.incremental?.billed;
		const parsed =
			billed === undefined ? undefined : parseDecimal(billed.decimal);
		if (
			billed === undefined ||
			parsed === undefined ||
			result.eligibility?.eligible === false ||
			result.unpriced.length > 0
		) {
			rejectedCandidates.push(
				reject(
					candidate,
					"INCOMPLETE_FINANCIAL_STATE",
					"quote has no completely priced incremental billed amount",
				),
			);
			continue;
		}
		const entry: (typeof priced)[number] = {
			candidate,
			quote: result,
			incrementalBilled: billed,
		};
		if (pricingModel !== undefined) entry.pricingModel = pricingModel;
		priced.push(entry);
	}

	const currency = priced[0]?.incrementalBilled.currency;
	const comparable = priced.filter((entry) => {
		if (entry.incrementalBilled.currency === currency) return true;
		rejectedCandidates.push(
			reject(
				entry.candidate,
				"CROSS_CURRENCY",
				"candidate quote currencies cannot be compared",
			),
		);
		return false;
	});
	comparable.sort((left, right) => {
		const leftDecimal = parseDecimal(left.incrementalBilled.decimal);
		const rightDecimal = parseDecimal(right.incrementalBilled.decimal);
		if (leftDecimal === undefined || rightDecimal === undefined) {
			throw new TypeError("priced quote returned an invalid decimal");
		}
		const billedCompare = compareDecimal(leftDecimal, rightDecimal);
		if (billedCompare !== 0) return billedCompare;
		const leftWaste = wasteScore(left.quote);
		const rightWaste = wasteScore(right.quote);
		if (leftWaste !== rightWaste) return leftWaste - rightWaste;
		const leftExpiry = earliestExpiryMs(left.quote);
		const rightExpiry = earliestExpiryMs(right.quote);
		if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
		return left.candidate.providerId.localeCompare(right.candidate.providerId);
	});
	const ranking = comparable.map((entry, index) => {
		const ranked: DispatchRankingV2 = {
			providerId: entry.candidate.providerId,
			rank: index + 1,
			incrementalBilled: entry.incrementalBilled,
			quote: withoutAllocatedEffective(entry.quote),
		};
		if (entry.pricingModel !== undefined)
			ranked.pricingModel = entry.pricingModel;
		return ranked;
	});
	rejectedCandidates.sort((left, right) =>
		left.providerId.localeCompare(right.providerId),
	);
	const winner = ranking[0];
	if (winner === undefined) {
		return {
			ok: false,
			schema: DISPATCHER_V2_SCHEMA_VERSION,
			objective,
			budget: BUDGET_DISCLOSURE,
			reason:
				candidates.length === 0
					? "no dispatch candidates"
					: "no completely priced dispatch candidates",
			ranking: [],
			rejectedCandidates,
		};
	}
	return {
		ok: true,
		schema: DISPATCHER_V2_SCHEMA_VERSION,
		objective,
		budget: BUDGET_DISCLOSURE,
		selectedProvider: winner.providerId,
		ranking,
		rejectedCandidates,
		dispatchEvent: {
			type: "dispatch.Decided",
			data: {
				dispatchId: request.dispatchId,
				category: request.category,
				schema: DISPATCHER_V2_SCHEMA_VERSION,
				objective,
				budget: BUDGET_DISCLOSURE,
				selectedProvider: winner.providerId,
				ranking,
				rejectedCandidates,
			},
		},
	};
}
