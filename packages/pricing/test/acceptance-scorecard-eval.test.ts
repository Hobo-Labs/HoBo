import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRICING_ACCEPTANCE_ROWS } from "../src/acceptance-scorecard.mts";
import { checkAcceptanceScorecardEvidence } from "./support/acceptance-scorecard-evidence.mts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const rows = PRICING_ACCEPTANCE_ROWS;

describe("provider pricing acceptance scorecard", () => {
	it("contains only accepted evidence rows", () => {
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => row.status === "pass")).toBe(true);
	});

	for (const row of rows.filter((entry) => entry.status === "pass")) {
		it(`${row.id}: ${row.evidenceTest}`, () => {
			const result = checkAcceptanceScorecardEvidence(repoRoot, row);
			expect(
				result.ok,
				result.ok
					? `${row.id} evidence check failed`
					: `${row.id}: ${result.reason}`,
			).toBe(true);
		});
	}
});
