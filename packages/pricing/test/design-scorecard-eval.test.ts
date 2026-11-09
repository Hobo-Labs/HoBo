import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDesignScorecard } from "../src/design-scorecard.mts";
import { checkDesignScorecardEvidence } from "./support/design-scorecard-evidence.mts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const rows = parseDesignScorecard(
	readFileSync(
		resolve(repoRoot, "docs/design/provider-pricing-scorecard.md"),
		"utf8",
	),
);

describe("provider pricing acceptance scorecard", () => {
	it("contains evidence rows and rejects partial, fail, or deferred acceptance", () => {
		expect(rows.length).toBeGreaterThan(0);
		expect(
			rows.filter(
				(row) =>
					row.status === "partial" ||
					row.status === "fail" ||
					row.status === "deferred",
			),
		).toEqual([]);
	});

	for (const row of rows.filter((entry) => entry.status === "pass")) {
		it(`${row.id}: ${row.evidenceTest}`, () => {
			const result = checkDesignScorecardEvidence(repoRoot, row);
			expect(
				result.ok,
				result.ok
					? `${row.id} evidence check failed`
					: `${row.id}: ${result.reason}`,
			).toBe(true);
		});
	}
});
