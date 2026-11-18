
export interface PriceObservation {
	readonly providerId: string;
	readonly sku: string;
	readonly region: string;
	readonly unit: string;
	readonly minorUnits: number;
	readonly currency: string;
	readonly source: string;
	readonly observedAtMs: number;
}

export interface PriceQuery {
	readonly providerId: string;
	readonly sku: string;
	readonly region: string;
	readonly unit: string;
	readonly nowMs: number;
	readonly maxAgeMs: number;
	readonly currency?: string;
}

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

	const ageMs = Math.max(0, query.nowMs - found.observedAtMs);
	return {
		status: ageMs > query.maxAgeMs ? "stale" : "priced",
		minorUnits: found.minorUnits,
		currency: found.currency,
		source: found.source,
		ageMs,
	};
}

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
