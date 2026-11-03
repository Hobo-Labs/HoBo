import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scorecardPath = join(
	import.meta.dirname,
	"..",
	"docs/design/fleet-enrollment-scorecard.md",
);

type ParsedRow = {
	section: string;
	requirement: string;
	status: string;
	evidence: string;
	line: string;
};

function parseScorecardRows(markdown: string): ParsedRow[] {
	const rows: ParsedRow[] = [];
	for (const line of markdown.split("\n")) {
		if (!line.startsWith("|") || line.includes("---")) continue;
		const cells = line
			.split("|")
			.map((cell) => cell.trim())
			.filter(Boolean);
		if (cells.length < 4 || cells[0] === "Section") continue;
		rows.push({
			section: cells[0] ?? "",
			requirement: cells[1] ?? "",
			status: (cells[2] ?? "").toLowerCase(),
			evidence: cells[3] ?? "",
			line,
		});
	}
	return rows;
}

describe("fleet enrollment scorecard", () => {
	it("rejects partial, fail, or deferred rows and reports blocked G9 rows separately", () => {
		const markdown = readFileSync(scorecardPath, "utf8");
		const rows = parseScorecardRows(markdown);
		const bad = new Set([
			"partial",
			"fail",
			"failed",
			"deferred",
			"todo",
			"skip",
		]);
		const allowed = new Set(["pass", "blocked-on-credentials"]);

		const invalidStatus: string[] = [];
		const unknownStatus: string[] = [];
		for (const row of rows) {
			if (bad.has(row.status)) invalidStatus.push(row.line);
			else if (!allowed.has(row.status)) unknownStatus.push(row.line);
		}
		expect(invalidStatus).toEqual([]);
		expect(unknownStatus).toEqual([]);

		const passRows = rows.filter((row) => row.status === "pass");
		const blockedRows = rows.filter(
			(row) => row.status === "blocked-on-credentials",
		);

		expect(passRows.length).toBeGreaterThan(80);
		expect(blockedRows.length).toBeGreaterThanOrEqual(12);

		const g9Blocked = blockedRows.filter(
			(row) =>
				row.requirement.startsWith("G9 ") ||
				row.requirement.startsWith("G9 live:") ||
				row.section === "18.9" ||
				row.requirement === "G9 production gate" ||
				row.requirement === "G10 production gate" ||
				row.requirement === "Final handoff vertical slice",
		);
		expect(g9Blocked.length).toBe(blockedRows.length);

		for (const row of blockedRows) {
			expect(row.evidence).toMatch(/GitHub App/i);
			expect(row.evidence).toMatch(/Installation ID/i);
			expect(row.evidence).toMatch(/Postgres/i);
			expect(row.evidence).toMatch(/Kubernetes|Station/i);
			expect(row.evidence).toMatch(/Dagger/i);
		}

		const totalMatch = markdown.match(/Total rows:\s*(\d+)/);
		expect(totalMatch).not.toBeNull();
		expect(Number(totalMatch?.[1])).toBe(rows.length);

		const passMatch = markdown.match(/Pass:\s*(\d+)/);
		const blockedMatch = markdown.match(
			/Blocked on credentials \(G9 live staging\):\s*(\d+)/,
		);
		expect(passMatch).not.toBeNull();
		expect(blockedMatch).not.toBeNull();
		expect(Number(passMatch?.[1])).toBe(passRows.length);
		expect(Number(blockedMatch?.[1])).toBe(blockedRows.length);
		expect(passRows.length + blockedRows.length).toBe(rows.length);
	});
});
