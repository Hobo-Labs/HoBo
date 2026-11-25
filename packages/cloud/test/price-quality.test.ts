/**
 * What a price is worth knowing about itself.
 *
 * Written before the implementation. N5's question is whether HoBo resources
 * multi-provider price data or scopes its cost claims to what it can actually
 * price. Resourcing the data is a commercial decision; scoping the claim is an
 * engineering one, and it needs teeth, because today the catalog cannot tell
 * the two apart:
 *
 *   - `marginalPrice` is a bare decimal string with no currency, no source and
 *     no staleness. `ResourceDefinition` drops the `currency` that `CostSignal`
 *     carried.
 *   - Every default in the repo is `marginalPrice: "0"`. Under `min-cost`,
 *     `Number.parseFloat("0")` ranks a provider that declared *nothing* ahead
 *     of every provider that declared a real price. Silence wins the auction.
 *   - An unparseable price becomes `+Infinity` and quietly loses instead of
 *     being reported as broken.
 *
 * So "unpriced" and "free" are the same fact to the planner. These tests make
 * them different facts, and make a cost-optimality claim refuse to be made on
 * inputs that cannot support it. That is the scoping decision, expressed as
 * something that fails rather than as a paragraph.
 */
import { describe, expect, it } from "vitest";

import {
	assessCostObjective,
	classifyPriceQuality,
	type PricedCandidate,
} from "../src/planner/price-quality.js";

function candidate(
	id: string,
	marginalPrice: string,
	overrides: Partial<PricedCandidate> = {},
): PricedCandidate {
	return {
		id,
		cost: { sku: id, unit: "hour", marginalPrice },
		...overrides,
	};
}

describe("classifyPriceQuality", () => {
	it("calls a real price priced", () => {
		expect(
			classifyPriceQuality({ sku: "s", unit: "hour", marginalPrice: "0.0123" }),
		).toBe("priced");
	});

	it('calls the repo-wide "0" default unpriced, not free', () => {
		// The whole point. Every provider manifest defaults to "0", and treating
		// that as a real price of zero makes silence win a min-cost ranking.
		expect(
			classifyPriceQuality({ sku: "s", unit: "hour", marginalPrice: "0" }),
		).toBe("unpriced");
	});

	it("calls an empty price unpriced", () => {
		expect(
			classifyPriceQuality({ sku: "s", unit: "hour", marginalPrice: "" }),
		).toBe("unpriced");
	});

	it("calls a non-numeric price unparseable rather than unpriced", () => {
		// A declared price that cannot be read is a bug in a manifest, not an
		// absence. Collapsing it into "unpriced" would hide the typo forever.
		expect(
			classifyPriceQuality({ sku: "s", unit: "hour", marginalPrice: "cheap" }),
		).toBe("unparseable");
	});

	it("calls a negative price unparseable", () => {
		expect(
			classifyPriceQuality({ sku: "s", unit: "hour", marginalPrice: "-1" }),
		).toBe("unparseable");
	});

	it("treats a genuinely free offering as priced when it says so", () => {
		// A real zero has to be expressible, or a free tier can never be modelled.
		// Saying it explicitly is the difference between a claim and a default.
		expect(
			classifyPriceQuality({
				sku: "s",
				unit: "hour",
				marginalPrice: "0",
				priceDeclared: true,
			}),
		).toBe("priced");
	});
});

describe("assessCostObjective", () => {
	it("is claimable when every candidate is priced", () => {
		const verdict = assessCostObjective({
			objective: "min-cost",
			candidates: [candidate("a", "0.10"), candidate("b", "0.20")],
		});
		expect(verdict.claimable).toBe(true);
		expect(verdict.unpriced).toEqual([]);
	});

	it("is not claimable when any candidate is unpriced", () => {
		// Ranking a priced candidate against an unpriced one does not produce a
		// cheapest choice; it produces a choice that cannot be defended.
		const verdict = assessCostObjective({
			objective: "min-cost",
			candidates: [candidate("a", "0.10"), candidate("b", "0")],
		});
		expect(verdict.claimable).toBe(false);
		expect(verdict.unpriced).toEqual(["b"]);
		expect(verdict.reason).toBe("unpriced-candidates");
	});

	it("names every unpriced candidate, sorted", () => {
		const verdict = assessCostObjective({
			objective: "min-cost",
			candidates: [
				candidate("z", "0"),
				candidate("a", "0"),
				candidate("m", "1"),
			],
		});
		expect(verdict.unpriced).toEqual(["a", "z"]);
	});

	it("reports unparseable candidates separately from unpriced ones", () => {
		const verdict = assessCostObjective({
			objective: "min-cost",
			candidates: [candidate("a", "0.10"), candidate("b", "cheap")],
		});
		expect(verdict.unparseable).toEqual(["b"]);
		expect(verdict.unpriced).toEqual([]);
		expect(verdict.reason).toBe("unparseable-prices");
	});

	it("prefers the unparseable reason, since it is a fixable defect", () => {
		// An unpriced provider is a data-coverage problem someone has to resource.
		// A malformed one is a typo, and saying so is more useful.
		const verdict = assessCostObjective({
			objective: "min-cost",
			candidates: [candidate("a", "0"), candidate("b", "cheap")],
		});
		expect(verdict.reason).toBe("unparseable-prices");
	});

	it("is claimable for a non-cost objective regardless of prices", () => {
		// Latency ranking does not rest on price, so unpriced candidates are not
		// this verdict's business.
		const verdict = assessCostObjective({
			objective: "latency",
			candidates: [candidate("a", "0"), candidate("b", "cheap")],
		});
		expect(verdict.claimable).toBe(true);
		expect(verdict.reason).toBeUndefined();
	});

	it('treats "cost" and "min-cost" alike, as the planner does', () => {
		for (const objective of ["cost", "min-cost"]) {
			expect(
				assessCostObjective({
					objective,
					candidates: [candidate("a", "0")],
				}).claimable,
			).toBe(false);
		}
	});

	it("is not claimable with no candidates at all", () => {
		// Nothing to compare is not the same as everything comparing equal.
		const verdict = assessCostObjective({
			objective: "min-cost",
			candidates: [],
		});
		expect(verdict.claimable).toBe(false);
		expect(verdict.reason).toBe("no-candidates");
	});

	it("counts how much of the candidate set could be priced", () => {
		const verdict = assessCostObjective({
			objective: "min-cost",
			candidates: [
				candidate("a", "0.10"),
				candidate("b", "0.20"),
				candidate("c", "0"),
				candidate("d", "0"),
			],
		});
		expect(verdict.coverage).toBeCloseTo(0.5, 5);
	});

	it("reports full coverage when every candidate is priced", () => {
		expect(
			assessCostObjective({
				objective: "min-cost",
				candidates: [candidate("a", "0.10")],
			}).coverage,
		).toBe(1);
	});

	it("reports zero coverage for an empty candidate set", () => {
		expect(
			assessCostObjective({ objective: "min-cost", candidates: [] }).coverage,
		).toBe(0);
	});

	it("is a pure function of its input", () => {
		const input = {
			objective: "min-cost",
			candidates: [candidate("a", "0.10"), candidate("b", "0")],
		};
		expect(assessCostObjective(input)).toEqual(assessCostObjective(input));
	});

	it("does not mutate its input", () => {
		const input = {
			objective: "min-cost",
			candidates: [candidate("z", "0"), candidate("a", "0")],
		};
		const before = structuredClone(input);
		assessCostObjective(input);
		expect(input).toEqual(before);
	});
});
