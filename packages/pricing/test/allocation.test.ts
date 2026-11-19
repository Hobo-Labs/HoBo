import { describe, expect, it } from "vitest";
import { allocationQuote, divideDecimalAtMost } from "../src/index.js";

describe("runner allocation arithmetic", () => {
	it("subtracts settled usage exactly and rounds the paid amount up", () => {
		expect(allocationQuote(1.1, [0.3], 1, 100)).toEqual({
			free: 0.8,
			reservedFree: 0.8,
			paid: 20,
		});
	});

	it("preserves scientific notation quantities", () => {
		expect(allocationQuote(1e-7, [2e-8], 1e-7, 1_000_000)).toEqual({
			free: 8e-8,
			reservedFree: 8e-8,
			paid: 1,
		});
	});

	it("does not round a divided allowance above its source", () => {
		expect(divideDecimalAtMost(0.1, 3)).toBe(0.03333333333333333);
		expect(() => divideDecimalAtMost(-1, 2)).toThrow(
			"invalid allocation conversion",
		);
	});
});
