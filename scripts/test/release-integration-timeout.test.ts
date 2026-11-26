import { describe, expect, it } from "vitest";
import { slow } from "../../packages/hobo/test/support/slow.js";

describe("release integration timeout", () => {
	it("keeps six minutes by default and only accepts a larger finite floor", () => {
		expect(slow(360_000, {})).toBe(360_000);
		expect(slow(360_000, { HOBO_TEST_TIMEOUT: "900000" })).toBe(900_000);
		for (const value of ["0", "300000", "invalid", "Infinity", "-1"])
			expect(slow(360_000, { HOBO_TEST_TIMEOUT: value })).toBe(360_000);
	});

	it("retains the freight realization's two-minute default", () => {
		expect(slow(120_000, {})).toBe(120_000);
		expect(slow(120_000, { HOBO_TEST_TIMEOUT: "900000" })).toBe(900_000);
		expect(slow(120_000, { HOBO_TEST_TIMEOUT: "1000" })).toBe(120_000);
	});
});
