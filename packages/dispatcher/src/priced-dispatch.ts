import {
	addDecimal,
	compareDecimal,
	DECIMAL_ZERO,
	isQuoteVector,
	type Money,
	parseDecimal,
	QuoteEngine,
	type QuoteScenario,
	type QuoteVector,
} from "@hobo/pricing";

export const PRICED_DISPATCH_SCHEMA = "hobo.dispatcher/priced";
export const PRICED_DISPATCH_OBJECTIVE = "min-incremental-billed" as const;

export type PricedDispatchCategory =
	| "runner"
	| "build-machine"
	| "traffic-backend";
export type DispatchCostQuote = Omit<QuoteVector, "allocatedEffective">;

export interface PricedDispatchCandidate {
	providerId: string;
	scenario: QuoteScenario;
}

export interface PricedDispatchRequest {
	dispatchId: string;
	category: PricedDispatchCategory;
	objective?: typeof PRICED_DISPATCH_OBJECTIVE;
	candidates: readonly PricedDispatchCandidate[];
}

export interface PricedDispatchRejection {
	providerId: string;
	code: string;
	reason: string;
}

export interface PricedDispatchRanking {
	providerId: string;
	rank: number;
	incrementalBilled: Money;
	quote: DispatchCostQuote;
}

export interface PricedDispatchEventRanking {
	providerId: string;
	rank: number;
	incrementalBilled: { decimal: string; currency: string };
	quoteHash: string;
}

export type PricedDispatchDecision =
	| {
			ok: true;
			schema: typeof PRICED_DISPATCH_SCHEMA;
			objective: typeof PRICED_DISPATCH_OBJECTIVE;
			selectedProvider: string;
			ranking: PricedDispatchRanking[];
			rejectedCandidates: PricedDispatchRejection[];
			dispatchEvent: {
				type: "dispatch.Priced";
				data: {
					dispatchId: string;
					category: PricedDispatchCategory;
					schema: typeof PRICED_DISPATCH_SCHEMA;
					objective: typeof PRICED_DISPATCH_OBJECTIVE;
					selectedProvider: string;
					ranking: PricedDispatchEventRanking[];
					rejectedCandidates: PricedDispatchRejection[];
				};
			};
	  }
	| {
			ok: false;
			schema: typeof PRICED_DISPATCH_SCHEMA;
			objective: typeof PRICED_DISPATCH_OBJECTIVE;
			reason: string;
			ranking: [];
			rejectedCandidates: PricedDispatchRejection[];
	  };

function withoutAllocatedEffective(quote: QuoteVector): DispatchCostQuote {
	const { allocatedEffective: _advisory, ...dispatchQuote } = quote;
	return dispatchQuote;
}

function wasteScore(quote: QuoteVector) {
	let total = DECIMAL_ZERO;
	for (const waste of quote.projectedWaste) {
		const amount = waste.amount?.value;
		if (amount?.case === "money" && amount.value?.decimal !== undefined) {
			const parsed = parseDecimal(amount.value.decimal);
			if (parsed !== undefined) total = addDecimal(total, parsed);
		}
	}
	return total;
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
	candidate: PricedDispatchCandidate,
	code: string,
	reason: string,
): PricedDispatchRejection {
	return { providerId: candidate.providerId, code, reason };
}

export function decidePricedDispatch(
	request: PricedDispatchRequest,
): PricedDispatchDecision {
	if (
		request.objective !== undefined &&
		request.objective !== PRICED_DISPATCH_OBJECTIVE
	) {
		throw new TypeError("objective must be min-incremental-billed");
	}
	if (request.dispatchId.length === 0) {
		throw new TypeError("dispatchId must be a non-empty string");
	}
	const objective = PRICED_DISPATCH_OBJECTIVE;
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

	const rejectedCandidates: PricedDispatchRejection[] = [];
	const priced: {
		candidate: PricedDispatchCandidate;
		quote: QuoteVector;
		incrementalBilled: Money;
	}[] = [];
	for (const candidate of candidates) {
		const result = QuoteEngine.quote(candidate.scenario);
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
		priced.push({ candidate, quote: result, incrementalBilled: billed });
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
		const wasteCompare = compareDecimal(leftWaste, rightWaste);
		if (wasteCompare !== 0) return wasteCompare;
		const leftExpiry = earliestExpiryMs(left.quote);
		const rightExpiry = earliestExpiryMs(right.quote);
		if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
		return left.candidate.providerId.localeCompare(right.candidate.providerId);
	});
	const ranking = comparable.map((entry, index) => ({
		providerId: entry.candidate.providerId,
		rank: index + 1,
		incrementalBilled: entry.incrementalBilled,
		quote: withoutAllocatedEffective(entry.quote),
	}));
	rejectedCandidates.sort((left, right) =>
		left.providerId.localeCompare(right.providerId),
	);
	const winner = ranking[0];
	if (winner === undefined) {
		return {
			ok: false,
			schema: PRICED_DISPATCH_SCHEMA,
			objective,
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
		schema: PRICED_DISPATCH_SCHEMA,
		objective,
		selectedProvider: winner.providerId,
		ranking,
		rejectedCandidates,
		dispatchEvent: {
			type: "dispatch.Priced",
			data: {
				dispatchId: request.dispatchId,
				category: request.category,
				schema: PRICED_DISPATCH_SCHEMA,
				objective,
				selectedProvider: winner.providerId,
				ranking: ranking.map((entry) => ({
					providerId: entry.providerId,
					rank: entry.rank,
					incrementalBilled: {
						decimal: entry.incrementalBilled.decimal,
						currency: entry.incrementalBilled.currency,
					},
					quoteHash: entry.quote.quoteHash,
				})),
				rejectedCandidates,
			},
		},
	};
}
