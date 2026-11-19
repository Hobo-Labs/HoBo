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
		const verdict = assessCostObjective({
			objective: "min-cost",
			candidates: [candidate("a", "0"), candidate("b", "cheap")],
		});
		expect(verdict.reason).toBe("unparseable-prices");
	});

	it("is claimable for a non-cost objective regardless of prices", () => {
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
