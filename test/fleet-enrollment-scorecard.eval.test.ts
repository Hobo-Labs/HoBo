import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scorecardPath = join(
	import.meta.dirname,
	"..",
	"docs/design/fleet-enrollment-scorecard.md",
);

describe("fleet enrollment scorecard", () => {
	it("rejects partial, fail, or deferred rows", () => {
		const markdown = readFileSync(scorecardPath, "utf8");
		const bad = new Set([
			"partial",
			"fail",
			"failed",
			"deferred",
			"todo",
			"skip",
		]);
		const offenders: string[] = [];
		for (const line of markdown.split("\n")) {
			if (!line.startsWith("|") || line.includes("---")) continue;
			const cells = line
				.split("|")
				.map((cell) => cell.trim())
				.filter(Boolean);
			if (cells.length < 4 || cells[0] === "Section") continue;
			const status = (cells[2] ?? "").toLowerCase();
			if (bad.has(status)) offenders.push(line);
			if (status !== "pass") offenders.push(line);
		}
		expect(offenders).toEqual([]);
		const totalMatch = markdown.match(/Total rows:\s*(\d+)/);
		expect(totalMatch).not.toBeNull();
		const rowCount = Number(totalMatch?.[1]);
		expect(rowCount).toBeGreaterThan(80);
	});
});
