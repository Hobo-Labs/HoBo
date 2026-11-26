import { expect, it } from "vitest";
import { formatDecimal, parseDecimal } from "../src/decimal.js";

it("parseDecimal rejects non-canonical wire decimals", () => {
	for (const value of [
		"-0",
		"-0.0",
		"00",
		"01",
		"+1",
		".1",
		"1.",
		"1e3",
		"NaN",
		"Infinity",
		" 1",
		"1 ",
	]) {
		expect(parseDecimal(value), value).toBeUndefined();
	}

	const canonical = parseDecimal("-12.340");
	expect(canonical).toBeDefined();
	if (canonical !== undefined) expect(formatDecimal(canonical)).toBe("-12.34");
});
