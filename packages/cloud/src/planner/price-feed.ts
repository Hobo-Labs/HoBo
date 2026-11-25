/**
 * The price feed, resourced from published data.
 *
 * N5's open half was a resourcing decision — build price data, license it, or
 * consume someone else's — and it looked like a purchase. It is not, because
 * the third option has a free form: AWS publishes a Price List Bulk API, Azure
 * a Retail Prices API, GCP a billing catalog, and Vantage publishes its data
 * openly. All are reachable without authentication and without a contract.
 *
 * Choosing published data is what makes the rest of this module's shape
 * inevitable, so the shape is the decision made concrete:
 *
 * **No credentials, by construction.** This core takes already-fetched
 * records. Adapters do the fetching, and nothing here can open a socket. That
 * is not a stylistic preference: Infracost's constraint — price the plan
 * without touching the customer's cloud account — removes the largest adoption
 * objection a cost tool faces, and the only reliable way to keep that property
 * is to make the credential-free part the part that cannot fetch.
 *
 * **A stale price is not a price.** Published prices move, and a feed fetched
 * once is a feed that decays. Past a caller-declared age a lookup reports
 * `stale` and hands back the figure *labelled as stale* rather than returning
 * something that reads as current. A confidently wrong price is worse than an
 * absent one, because the absent one gets investigated.
 *
 * **Currency travels with the amount.** `ResourceDefinition.cost` drops the
 * currency `CostSignal` carried, which is exactly how a EUR price silently
 * becomes a USD one. Here it is part of the record and part of the match.
 *
 * **Integer minor units.** The same argument as ADR-0166: floats lose cents,
 * and cents are what get a cost surface disbelieved.
 */

/** One published price, as an adapter read it. */
export interface PriceObservation {
	readonly providerId: string;
	readonly sku: string;
	readonly region: string;
	/** The billing unit — "hour", "month", "gb-month". Part of the identity. */
	readonly unit: string;
	readonly minorUnits: number;
	readonly currency: string;
	/** Where this came from, so a figure can be traced back and checked. */
	readonly source: string;
	readonly observedAtMs: number;
}

export interface PriceQuery {
	readonly providerId: string;
	readonly sku: string;
	readonly region: string;
	readonly unit: string;
	readonly nowMs: number;
	/** How old a published price may be and still be served. */
	readonly maxAgeMs: number;
	/** When set, a price in another currency is refused rather than converted. */
	readonly currency?: string;
}

/**
 * - `priced` — a fresh price in an acceptable currency.
 * - `stale` — found, but older than the caller allows.
 * - `currency-mismatch` — found, but denominated in something else.
 * - `unpriced` — the feed has nothing for this key.
 */
export type PriceLookupStatus =
	| "priced"
	| "stale"
	| "currency-mismatch"
	| "unpriced";

export interface PriceLookup {
	readonly status: PriceLookupStatus;
	readonly minorUnits?: number;
	readonly currency?: string;
	readonly source?: string;
	readonly ageMs?: number;
}

export interface PriceBook {
	readonly entries: ReadonlyMap<string, PriceObservation>;
}

export interface PriceBookCoverage {
	readonly priced: number;
	readonly total: number;
	readonly fraction: number;
	/** The keys nothing could price, sorted, so the gap is actionable. */
	readonly missing: readonly string[];
}

function keyOf(parts: {
	providerId: string;
	sku: string;
	region: string;
	unit: string;
}): string {
	return `${parts.providerId}:${parts.sku}:${parts.region}:${parts.unit}`;
}

/**
 * Whether a record is usable at all.
 *
 * A published feed is someone else's output, so it is exactly the input most
 * likely to contain something that cannot be a price. Rejecting here means a
 * bad record never reaches a decision; note that a rejected record also must
 * not displace a good one, which is why filtering happens before the
 * newest-wins comparison rather than after it.
 */
function usable(observation: PriceObservation): boolean {
	if (observation.sku.length === 0) return false;
	if (observation.providerId.length === 0) return false;
	const price = observation.minorUnits;
	return Number.isInteger(price) && price >= 0;
}

export function buildPriceBook(
	observations: readonly PriceObservation[],
): PriceBook {
	const entries = new Map<string, PriceObservation>();
	for (const observation of observations) {
		if (!usable(observation)) continue;
		const key = keyOf(observation);
		const held = entries.get(key);
		// Newest wins: feeds get re-fetched, and the newer publication is the
		// current price regardless of the order records arrive in.
		if (held === undefined || observation.observedAtMs > held.observedAtMs)
			entries.set(key, observation);
	}
	return { entries };
}

export function lookupPrice(book: PriceBook, query: PriceQuery): PriceLookup {
	const found = book.entries.get(keyOf(query));
	if (found === undefined) return { status: "unpriced" };

	if (query.currency !== undefined && query.currency !== found.currency) {
		return {
			status: "currency-mismatch",
			minorUnits: found.minorUnits,
			currency: found.currency,
			source: found.source,
		};
	}

	// Clamped at zero: a publisher's clock running ahead of ours is not the
	// operator's problem, and a negative age would read as freshness.
	const ageMs = Math.max(0, query.nowMs - found.observedAtMs);
	return {
		status: ageMs > query.maxAgeMs ? "stale" : "priced",
		minorUnits: found.minorUnits,
		currency: found.currency,
		source: found.source,
		ageMs,
	};
}

/**
 * How much of a wanted set this book can price right now.
 *
 * This is the number that argues for or against paying for a feed, so a stale
 * price counts as uncovered: coverage is about what can be priced today, not
 * about what was once known.
 */
export function priceBookCoverage(
	book: PriceBook,
	queries: readonly PriceQuery[],
): PriceBookCoverage {
	const missing: string[] = [];
	let priced = 0;
	for (const query of queries) {
		if (lookupPrice(book, query).status === "priced") priced += 1;
		else missing.push(keyOf(query));
	}
	missing.sort();
	return {
		priced,
		total: queries.length,
		fraction: queries.length === 0 ? 0 : priced / queries.length,
		missing,
	};
}
