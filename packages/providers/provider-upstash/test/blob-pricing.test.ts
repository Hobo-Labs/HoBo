import { describe, expect, it } from "vitest";
import { estimateUpstashBlobLiability } from "../src/blob-pricing.js";

const rates = {
	simpleMicrosPerMillion: 300_000,
	advancedMicrosPerMillion: 4_500_000,
	deleteMicrosPerMillion: 0,
	storageMicrosPerGbMonth: 20_000,
	egressMicrosPerGb: 20_000,
	mintMicrosPerCall: 1,
};
const demand = {
	simple: 1,
	advanced: 2,
	deletes: 0,
	storage: 1_000_000_000,
	egress: 1_000_000_000,
	mint: 1,
	retentionMs: 86_400_000,
	rates,
};

describe("Upstash Blob metered liability", () => {
	it("rounds each operation and byte meter conservatively", () => {
		expect(estimateUpstashBlobLiability(demand)).toBe(40_018);
		expect(
			estimateUpstashBlobLiability({
				...demand,
				retentionMs: 28 * 86_400_000 + 1,
			}),
		).toBe(60_018);
	});

	it("does not invent a cost or charge for absent work", () => {
		expect(
			estimateUpstashBlobLiability({
				...demand,
				simple: 0,
				advanced: 0,
				storage: 0,
				egress: 0,
				mint: 0,
			}),
		).toBe(0);
	});

	it("fails closed on invalid bounds and unsafe totals", () => {
		for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
			expect(() =>
				estimateUpstashBlobLiability({ ...demand, simple: value }),
			).toThrow();
			expect(() =>
				estimateUpstashBlobLiability({
					...demand,
					rates: { ...rates, mintMicrosPerCall: value },
				}),
			).toThrow();
		}
		expect(() =>
			estimateUpstashBlobLiability({ ...demand, retentionMs: 0 }),
		).toThrow();
		expect(() =>
			estimateUpstashBlobLiability({
				...demand,
				mint: Number.MAX_SAFE_INTEGER,
				rates: { ...rates, mintMicrosPerCall: 2 },
			}),
		).toThrow(/safe bounds/u);
	});
});
