import { describe, expect, it } from "vitest";
import { confirmsNeonSqlProbe } from "../src/sql-probe.js";

describe("actual SQL probe response boundary", () => {
	it("accepts native array and object rows with the exact SELECT result", () => {
		for (const row of [
			[1],
			["1"],
			{ hobo_validation: 1 },
			{ hobo_validation: "1" },
		])
			expect(
				confirmsNeonSqlProbe(
					JSON.stringify({
						fields: [{ name: "hobo_validation" }],
						rows: [row],
					}),
				),
			).toBe(true);
	});
	it("does not accept an echoed query, wrong alias, wrong value or ambiguous rows", () => {
		for (const body of [
			{ error: "SELECT 1 AS hobo_validation" },
			{ fields: [{ name: "different" }], rows: [[1]] },
			{ fields: [{ name: "hobo_validation" }], rows: [[2]] },
			{ rows: [{ hobo_validation: true }] },
			{ rows: [{ hobo_validation: 1 }, { hobo_validation: 1 }] },
			{ rows: [] },
			null,
		])
			expect(confirmsNeonSqlProbe(JSON.stringify(body))).toBe(false);
		expect(confirmsNeonSqlProbe("not JSON")).toBe(false);
	});
});
