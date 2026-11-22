#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	rows as expectedRows,
	type Row,
} from "./generate-fleet-enrollment-scorecard.mts";

export function assessScorecard(
	markdown: string,
	expected: readonly Row[] = expectedRows,
) {
	const rows = markdown
		.split("\n")
		.filter((line) => line.startsWith("|") && !/^\|\s*---/.test(line))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim()),
		)
		.filter((cells) => cells[0] !== "Section");
	if (
		expected.length === 0 ||
		rows.length !== expected.length ||
		rows.some((cells, index) => {
			const row = expected[index];
			return (
				cells.length !== 4 ||
				!row ||
				cells[0] !== row.section ||
				cells[1] !== row.item ||
				cells[2] !== row.status ||
				cells[3] !== row.evidence
			);
		})
	)
		return {
			ready: false,
			message:
				"Fleet scorecard is incomplete, malformed, or stale; regenerate it.",
		};
	const unresolved = rows.filter((cells) => {
		const evidence = cells[3] ?? "";
		return (
			cells[2] !== "pass" ||
			!/verified at [a-f0-9]{40}/.test(evidence) ||
			!(
				/case "[^"]+".*\.test\.ts/.test(evidence) ||
				/artifact:\s*https:\/\/\S+/.test(evidence)
			)
		);
	});
	if (unresolved.length > 0)
		return {
			ready: false,
			message: `Fleet scorecard has ${unresolved.length} unresolved requirement(s).`,
		};
	return {
		ready: true,
		message:
			"All fleet scorecard rows are marked pass; verify evidence freshness and release scope separately.",
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	if (process.argv.length > 3) {
		console.error(
			"Usage: node --experimental-strip-types scripts/check-fleet-enrollment-readiness.mts [scorecard]",
		);
		process.exit(2);
	}
	try {
		const path = resolve(
			process.argv[2] ?? "docs/design/fleet-enrollment-scorecard.md",
		);
		const result = assessScorecard(readFileSync(path, "utf8"));
		if (result.ready) console.log(result.message);
		else {
			console.error(result.message);
			process.exitCode = 1;
		}
	} catch {
		console.error("Unable to read fleet scorecard.");
		process.exitCode = 1;
	}
}
