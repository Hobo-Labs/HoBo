/**
 * A price feed HoBo can actually have.
 *
 * Written before the implementation. N5's open half was the resourcing
 * decision: build price data, license it, or consume someone else's. The third
 * option has a free form — AWS's Price List Bulk API, Azure's Retail Prices
 * API, GCP's billing catalog and Vantage's public data are all published
 * without authentication — so it needs no purchase and no vendor commitment.
 *
 * That choice shapes the port, and the tests are mostly about the shape:
 *
 *   - **No credentials, by construction.** The core takes already-fetched
 *     records; adapters do the fetching. Estimation therefore cannot acquire a
 *     credential dependency by accident, which is Infracost's constraint and
 *     the thing that removes the largest adoption objection for a cost tool.
 *   - **A stale price is not a price.** Published prices change. Past a
 *     declared age a lookup reports staleness rather than returning a number
 *     that looks current, because a confidently wrong price is worse than an
 *     absent one.
 *   - **Currency travels with the amount.** The catalog drops it today, which
 *     is how a EUR price silently becomes a USD one.
 *   - **Minor units.** Same argument as ADR-0166: floats lose cents, and cents
 *     are what get a cost surface disbelieved.
 */
import { describe, expect, it } from "vitest";

import {
	buildPriceBook,
	lookupPrice,
	type PriceObservation,
	type PriceQuery,
	priceBookCoverage,
} from "../src/planner/price-feed.js";

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function observation(
	overrides: Partial<PriceObservation> = {},
): PriceObservation {
	return {
		providerId: "aws",
		sku: "t3.micro",
		region: "us-east-1",
		unit: "hour",
		minorUnits: 104,
		currency: "USD",
		source: "aws-price-list",
		observedAtMs: NOW - HOUR,
		...overrides,
	};
}

function query(overrides: Partial<PriceQuery> = {}): PriceQuery {
	return {
		providerId: "aws",
		sku: "t3.micro",
		region: "us-east-1",
		unit: "hour",
		nowMs: NOW,
		maxAgeMs: 30 * 24 * HOUR,
		...overrides,
	};
}

describe("building a price book", () => {
	it("indexes an observation so it can be found again", () => {
		const book = buildPriceBook([observation()]);
		expect(lookupPrice(book, query()).status).toBe("priced");
	});

	it("reports nothing for a sku it never saw", () => {
		const book = buildPriceBook([observation()]);
		expect(lookupPrice(book, query({ sku: "t3.large" })).status).toBe(
			"unpriced",
		);
	});

	it("keys on region, since the same sku differs by region", () => {
		const book = buildPriceBook([observation()]);
		expect(lookupPrice(book, query({ region: "eu-west-1" })).status).toBe(
			"unpriced",
		);
	});

	it("keys on provider, so two providers' skus cannot collide", () => {
		const book = buildPriceBook([observation()]);
		expect(lookupPrice(book, query({ providerId: "gcp" })).status).toBe(
			"unpriced",
		);
	});

	it("keys on unit, because per-hour and per-month are different prices", () => {
		const book = buildPriceBook([observation()]);
		expect(lookupPrice(book, query({ unit: "month" })).status).toBe("unpriced");
	});

	it("is empty for no observations", () => {
		expect(lookupPrice(buildPriceBook([]), query()).status).toBe("unpriced");
	});
});

describe("conflicting observations", () => {
	it("keeps the most recently observed price", () => {
		// Feeds get re-fetched. The newer publication is the current price.
		const book = buildPriceBook([
			observation({ minorUnits: 100, observedAtMs: NOW - 5 * HOUR }),
			observation({ minorUnits: 104, observedAtMs: NOW - HOUR }),
		]);
		expect(lookupPrice(book, query()).minorUnits).toBe(104);
	});

	it("keeps the newest regardless of the order they arrive in", () => {
		const book = buildPriceBook([
			observation({ minorUnits: 104, observedAtMs: NOW - HOUR }),
			observation({ minorUnits: 100, observedAtMs: NOW - 5 * HOUR }),
		]);
		expect(lookupPrice(book, query()).minorUnits).toBe(104);
	});

	it("reports which source the surviving price came from", () => {
		// A price nobody can trace is a price nobody can check.
		const book = buildPriceBook([observation({ source: "vantage-public" })]);
		expect(lookupPrice(book, query()).source).toBe("vantage-public");
	});
});

describe("staleness", () => {
	it("serves a price inside the age limit", () => {
		const book = buildPriceBook([
			observation({ observedAtMs: NOW - 10 * 24 * HOUR }),
		]);
		expect(lookupPrice(book, query()).status).toBe("priced");
	});

	it("refuses a price past the age limit", () => {
		// A confidently wrong price is worse than an absent one.
		const book = buildPriceBook([
			observation({ observedAtMs: NOW - 90 * 24 * HOUR }),
		]);
		expect(lookupPrice(book, query()).status).toBe("stale");
	});

	it("still reports the stale figure and its age, so it can be shown as stale", () => {
		const book = buildPriceBook([
			observation({ minorUnits: 104, observedAtMs: NOW - 90 * 24 * HOUR }),
		]);
		const found = lookupPrice(book, query());
		expect(found.minorUnits).toBe(104);
		expect(found.ageMs).toBe(90 * 24 * HOUR);
	});

	it("treats the boundary as fresh rather than stale", () => {
		const book = buildPriceBook([
			observation({ observedAtMs: NOW - 30 * 24 * HOUR }),
		]);
		expect(lookupPrice(book, query()).status).toBe("priced");
	});

	it("does not age a price observed in the future into staleness", () => {
		// Clock skew between a publisher and us is not the operator's problem.
		const book = buildPriceBook([observation({ observedAtMs: NOW + HOUR })]);
		expect(lookupPrice(book, query()).status).toBe("priced");
	});

	it("never serves a price when no age limit makes sense", () => {
		const book = buildPriceBook([observation()]);
		expect(lookupPrice(book, query({ maxAgeMs: 0 })).status).toBe("stale");
	});
});

describe("currency", () => {
	it("carries the currency with the amount", () => {
		const book = buildPriceBook([observation({ currency: "EUR" })]);
		expect(lookupPrice(book, query()).currency).toBe("EUR");
	});

	it("refuses a price in a currency the caller did not ask for", () => {
		// The catalog drops currency today, which is how a EUR price silently
		// becomes a USD one.
		const book = buildPriceBook([observation({ currency: "EUR" })]);
		expect(lookupPrice(book, query({ currency: "USD" })).status).toBe(
			"currency-mismatch",
		);
	});

	it("serves a price when the requested currency matches", () => {
		const book = buildPriceBook([observation({ currency: "EUR" })]);
		expect(lookupPrice(book, query({ currency: "EUR" })).status).toBe("priced");
	});

	it("serves any currency when the caller did not name one", () => {
		const book = buildPriceBook([observation({ currency: "GBP" })]);
		expect(lookupPrice(book, query()).status).toBe("priced");
	});
});

describe("rejecting unusable observations", () => {
	it("drops a negative price rather than indexing it", () => {
		const book = buildPriceBook([observation({ minorUnits: -1 })]);
		expect(lookupPrice(book, query()).status).toBe("unpriced");
	});

	it("drops a non-integer price, since minor units are integers", () => {
		const book = buildPriceBook([observation({ minorUnits: 10.5 })]);
		expect(lookupPrice(book, query()).status).toBe("unpriced");
	});

	it("drops a non-finite price", () => {
		const book = buildPriceBook([
			observation({ minorUnits: Number.POSITIVE_INFINITY }),
		]);
		expect(lookupPrice(book, query()).status).toBe("unpriced");
	});

	it("keeps a genuinely free published price", () => {
		// Zero from a feed is a real published price, unlike a "0" default.
		const book = buildPriceBook([observation({ minorUnits: 0 })]);
		const found = lookupPrice(book, query());
		expect(found.status).toBe("priced");
		expect(found.minorUnits).toBe(0);
	});

	it("drops an observation with an empty sku", () => {
		const book = buildPriceBook([observation({ sku: "" })]);
		expect(lookupPrice(book, query({ sku: "" })).status).toBe("unpriced");
	});

	it("does not let a dropped observation shadow a good one", () => {
		// The bad record is newer. Rejecting it must not also lose the good one.
		const book = buildPriceBook([
			observation({ minorUnits: 104, observedAtMs: NOW - 5 * HOUR }),
			observation({ minorUnits: -5, observedAtMs: NOW - HOUR }),
		]);
		expect(lookupPrice(book, query()).minorUnits).toBe(104);
	});
});

describe("coverage", () => {
	it("reports what fraction of a wanted set the book can price", () => {
		// The number that argues for or against paying for a feed.
		const book = buildPriceBook([
			observation({ sku: "a" }),
			observation({ sku: "b" }),
		]);
		const coverage = priceBookCoverage(book, [
			query({ sku: "a" }),
			query({ sku: "b" }),
			query({ sku: "c" }),
			query({ sku: "d" }),
		]);
		expect(coverage.priced).toBe(2);
		expect(coverage.total).toBe(4);
		expect(coverage.fraction).toBeCloseTo(0.5, 5);
	});

	it("counts a stale price as uncovered, not as covered", () => {
		// Coverage is about what can be priced *now*.
		const book = buildPriceBook([
			observation({ observedAtMs: NOW - 900 * 24 * HOUR }),
		]);
		expect(priceBookCoverage(book, [query()]).priced).toBe(0);
	});

	it("names what it could not price, so the gap is actionable", () => {
		const book = buildPriceBook([observation({ sku: "a" })]);
		const coverage = priceBookCoverage(book, [
			query({ sku: "a" }),
			query({ sku: "z" }),
			query({ sku: "m" }),
		]);
		expect(coverage.missing).toEqual([
			"aws:m:us-east-1:hour",
			"aws:z:us-east-1:hour",
		]);
	});

	it("reports zero coverage for an empty book", () => {
		expect(priceBookCoverage(buildPriceBook([]), [query()]).fraction).toBe(0);
	});

	it("reports zero rather than dividing by zero for no queries", () => {
		expect(priceBookCoverage(buildPriceBook([]), []).fraction).toBe(0);
	});
});

describe("purity", () => {
	it("builds the same book from the same observations", () => {
		const input = [observation({ sku: "a" }), observation({ sku: "b" })];
		expect(lookupPrice(buildPriceBook(input), query({ sku: "a" }))).toEqual(
			lookupPrice(buildPriceBook(input), query({ sku: "a" })),
		);
	});

	it("does not mutate the observations it was given", () => {
		const input = [observation()];
		const before = structuredClone(input);
		buildPriceBook(input);
		expect(input).toEqual(before);
	});

	it("takes no credentials and performs no I/O", () => {
		// Structural, and the point of the whole design: the core accepts
		// already-fetched records, so estimation cannot acquire a credential
		// dependency by accident. Adapters fetch; this does not.
		expect(buildPriceBook.length).toBe(1);
	});
});
