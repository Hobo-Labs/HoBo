import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessScorecard } from "../scripts/check-fleet-enrollment-readiness.mts";

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
		if (!line.startsWith("|") || /^\|\s*---/.test(line)) continue;
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
	it("blocks the readiness check for unresolved or malformed scorecards", () => {
		const script = join(
			import.meta.dirname,
			"..",
			"scripts/check-fleet-enrollment-readiness.mts",
		);
		const run = (path: string) =>
			spawnSync(
				process.execPath,
				["--experimental-strip-types", script, path],
				{ encoding: "utf8" },
			);
		const current = run(scorecardPath);
		const assessment = assessScorecard(readFileSync(scorecardPath, "utf8"));
		expect(current.status).toBe(assessment.ready ? 0 : 1);
		expect(assessment.ready ? current.stdout : current.stderr).toContain(
			assessment.message,
		);
		const dir = mkdtempSync(join(tmpdir(), "fleet-scorecard-"));
		try {
			const path = join(dir, "scorecard.md");
			writeFileSync(
				path,
				"| Section | Requirement | Status | Evidence |\n| --- | --- | --- | --- |\n| 1 | example | pass |\n",
			);
			expect(run(path).status).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const evidence = `case "example" in example.test.ts, verified at ${"a".repeat(40)}`;
		const expected = [
			{ section: "1", item: "example", status: "pass" as const, evidence },
		];
		const complete = `| Section | Requirement | Status | Evidence |\n| --- | --- | --- | --- |\n| 1 | example | pass | ${evidence} |\n`;
		expect(assessScorecard(complete, expected).ready).toBe(true);
		expect(
			assessScorecard(complete.replace(evidence, "a design document"), expected)
				.ready,
		).toBe(false);
		expect(assessScorecard("", expected).ready).toBe(false);
		expect(assessScorecard(complete, []).ready).toBe(false);
	});

	it("reports scoped evidence and keeps unverified release requirements visible", () => {
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
		const allowed = new Set([
			"pass",
			"not-verified",
			"blocked-on-credentials",
			"not-implemented",
		]);

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
		const notImplementedRows = rows.filter(
			(row) => row.status === "not-implemented",
		);
		const notVerifiedRows = rows.filter((row) => row.status === "not-verified");

		for (const row of passRows) {
			expect(row.evidence).toMatch(/verified at [a-f0-9]{40}/);
			const testCase = row.evidence.match(/case "([^"]+)"/)?.[1];
			const testPath = row.evidence.match(
				/(?:packages|test|scripts\/test)\/[^ ,]+\.test\.ts/,
			)?.[0];
			if (testCase && testPath)
				expect(
					readFileSync(join(import.meta.dirname, "..", testPath), "utf8"),
				).toContain(testCase);
			else expect(row.evidence).toMatch(/artifact:\s*https:\/\/\S+/);
		}
		const crashRows = rows.filter((row) =>
			row.requirement.startsWith("Crash cut "),
		);
		const guardrailRows = rows.filter((row) =>
			row.requirement.startsWith("Guardrail "),
		);
		const gateRows = rows.filter((row) =>
			/\bG\d+ production gate$/.test(row.requirement),
		);
		const liveRows = rows.filter((row) =>
			row.requirement.startsWith("G9 live:"),
		);
		expect(crashRows).toHaveLength(15);
		expect(guardrailRows).toHaveLength(20);
		expect(gateRows).toHaveLength(11);
		expect(liveRows).toHaveLength(10);
		for (const row of [...gateRows, ...liveRows].filter(
			(row) => row.status === "pass",
		))
			expect(row.evidence).toMatch(/artifact:\s*https:\/\/\S+/);

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
		const notImplementedMatch = markdown.match(/Not implemented:\s*(\d+)/);
		const notVerifiedMatch = markdown.match(/Not verified:\s*(\d+)/);
		expect(passMatch).not.toBeNull();
		expect(blockedMatch).not.toBeNull();
		expect(notImplementedMatch).not.toBeNull();
		expect(notVerifiedMatch).not.toBeNull();
		expect(Number(passMatch?.[1])).toBe(passRows.length);
		expect(Number(blockedMatch?.[1])).toBe(blockedRows.length);
		expect(Number(notImplementedMatch?.[1])).toBe(notImplementedRows.length);
		expect(Number(notVerifiedMatch?.[1])).toBe(notVerifiedRows.length);
		expect(
			passRows.length +
				blockedRows.length +
				notImplementedRows.length +
				notVerifiedRows.length,
		).toBe(rows.length);
	});
});
