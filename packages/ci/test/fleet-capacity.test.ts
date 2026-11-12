import { describe, expect, it } from "vitest";
import {
	memoryAdmitHeadroom,
	memoryAdmitParallelCount,
} from "../src/fleet/capacity.js";

describe("fleet capacity", () => {
	it("refuses admit when available memory is below reserve + job + volatility", () => {
		expect(memoryAdmitHeadroom(4096, 4096, 2048, 1024)).toBe(false);
		expect(memoryAdmitHeadroom(7168, 4096, 2048, 1024)).toBe(true);
	});

	it("counts parallel standard jobs from OS headroom", () => {
		const reserve = 2048;
		const volatility = 1024;
		const request = 4096;
		expect(
			memoryAdmitParallelCount(9_932, request, reserve, volatility, 8),
		).toBe(1);
		expect(
			memoryAdmitParallelCount(20_480, request, reserve, volatility, 8),
		).toBe(4);
		expect(
			memoryAdmitParallelCount(11_264, request, reserve, volatility, 3),
		).toBe(2);
	});
});
