export type DesignScorecardStatus = "pass" | "partial" | "fail" | "deferred";

export type DesignScorecardRow = Readonly<{
	id: string;
	status: DesignScorecardStatus;
	evidenceFile: string;
	evidenceTest: string;
}>;

function isStatus(value: string): value is DesignScorecardStatus {
	return new Set(["pass", "partial", "fail", "deferred"]).has(value);
}

export function parseDesignScorecard(markdown: string): DesignScorecardRow[] {
	const rows: DesignScorecardRow[] = [];
	for (const line of markdown.split(/\r?\n/)) {
		if (!line.trimStart().startsWith("|")) continue;
		const cells = line
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());
		const [id, status, evidenceFile, evidenceTest] = cells;
		if (
			cells.length !== 4 ||
			id === undefined ||
			status === undefined ||
			evidenceFile === undefined ||
			evidenceTest === undefined ||
			!isStatus(status)
		) {
			continue;
		}
		rows.push({ id, status, evidenceFile, evidenceTest });
	}
	return rows;
}
