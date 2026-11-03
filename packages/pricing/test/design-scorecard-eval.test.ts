import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDesignScorecard } from "../src/design-scorecard.mts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const rows = parseDesignScorecard(
	readFileSync(
		resolve(repoRoot, "docs/design/provider-pricing-scorecard.md"),
		"utf8",
	),
);

describe("provider pricing acceptance scorecard", () => {
	it("contains evidence rows and rejects partial or failed acceptance", () => {
		expect(rows.length).toBeGreaterThan(0);
		expect(
			rows.filter((row) => row.status === "partial" || row.status === "fail"),
		).toEqual([]);
	});

	for (const row of rows.filter((entry) => entry.status === "pass")) {
		it(`${row.id}: ${row.evidenceTest}`, () => {
			const result = spawnSync(
				"pnpm",
				["exec", "vitest", "run", row.evidenceFile, "-t", row.evidenceTest],
				{ cwd: repoRoot, encoding: "utf8" },
			);
			const output = `${result.stdout}${result.stderr}`;
			expect(result.error, output).toBeUndefined();
			expect(result.status, `${row.id} evidence failed\n${output}`).toBe(0);
		});
	}

	for (const row of rows.filter((entry) => entry.status === "deferred")) {
		it(`${row.id} defers only live provider billing sync`, () => {
			expect(row.id).toBe("§12.5");
			expect(`${row.evidenceFile} ${row.evidenceTest}`).toMatch(
				/live provider billing sync/i,
			);
		});
	}
});
