/**
 * A committable rendering of a derived matrix.
 *
 * The output is a pure function of the matrix: fixed row and column order from
 * the grid, fixed field order inside every cell, and the only instant printed
 * is the one the caller passed to the generator. No wall clock is read, so
 * regenerating this file in CI produces an empty diff unless coverage actually
 * moved — which is what makes the diff readable as evidence.
 */
import { BINDLE_PRIMITIVES, BINDLE_RUNTIMES } from "@hobo/capability-profiles";

import { CANDIDATE_BUCKETS, type CandidateBucket } from "./candidate.js";
import { cellKey } from "./grid.js";
import type { CapabilityMatrix, CapabilityMatrixCell } from "./matrix.js";

/** Single-letter bucket markers, in the order every cell prints them. */
const BUCKET_MARKERS: readonly (readonly [CandidateBucket, string])[] = [
	["native", "n"],
	["pack", "p"],
	["bridge", "b"],
	["substrate", "h"],
	["sponsor", "s"],
];

const LEGEND = [
	"Legend: `n` provider-native · `p` HoBo pack on generic compute · `b` bridge ·",
	"`h` HoBo-operated substrate · `s` sponsor-backed fallback. Counts are of",
	"definitions selectable at the evaluation instant; definitions held back by",
	"evidence or conformance state are listed under Held back, never added in.",
].join("\n");

function availableSummary(cell: CapabilityMatrixCell): string {
	return BUCKET_MARKERS.map(
		([bucket, marker]) => `${marker}${cell.buckets[bucket].available.length}`,
	).join(" ");
}

function tableRow(cells: readonly string[]): string {
	return `| ${cells.join(" | ")} |`;
}

function cellsByKey(
	matrix: CapabilityMatrix,
): ReadonlyMap<string, CapabilityMatrixCell> {
	return new Map(matrix.cells.map((cell) => [cell.key, cell]));
}

/**
 * Render the grid plus a per-cell breakdown.
 *
 * The table answers "where is there coverage"; the breakdown answers "of what
 * kind, and what is held back". They are separate sections because collapsing
 * them into one would require summing buckets that must not be summed.
 */
export function renderCapabilityMatrixMarkdown(
	matrix: CapabilityMatrix,
): string {
	const byKey = cellsByKey(matrix);
	const lines: string[] = [
		"# HoBo capability matrix",
		"",
		"Derived from registered Resource Definitions and their trust evidence.",
		"This file is generated; edit the catalog, not the table.",
		"",
		`- Evaluation instant: \`${matrix.evaluatedAtMs}\``,
		`- Matrix digest: \`${matrix.digest}\``,
		`- Profile registry digest: \`${matrix.profileRegistryDigest}\``,
		`- Trust bundle digest: \`${matrix.trustBundleDigest}\``,
		"",
		"## Coverage",
		"",
		tableRow(["primitive \\ runtime", ...BINDLE_RUNTIMES]),
		tableRow(["---", ...BINDLE_RUNTIMES.map(() => "---")]),
	];

	for (const primitive of BINDLE_PRIMITIVES) {
		const columns = BINDLE_RUNTIMES.map((runtime) => {
			const cell = byKey.get(cellKey(primitive, runtime));
			if (cell === undefined) return "—";
			return `${cell.verdict}<br>${availableSummary(cell)}`;
		});
		lines.push(tableRow([primitive, ...columns]));
	}

	lines.push("", LEGEND, "", "## Registered candidates", "");

	const occupied = matrix.cells.filter((cell) => cell.candidates.length > 0);
	if (occupied.length === 0) {
		lines.push(
			"No definition is registered for any cell. The matrix is empty because",
			"the catalog is, not because coverage was omitted.",
		);
	} else {
		for (const cell of occupied) {
			lines.push(`### ${cell.key}`, "", `- verdict: ${cell.verdict}`);
			for (const bucket of CANDIDATE_BUCKETS) {
				const occupancy = cell.buckets[bucket];
				if (occupancy.available.length === 0) continue;
				lines.push(`- ${bucket}: ${occupancy.available.join(", ")}`);
			}
			const heldBack = CANDIDATE_BUCKETS.flatMap((bucket) =>
				cell.buckets[bucket].unavailable.map((id) => `${id} (${bucket})`),
			);
			if (heldBack.length > 0) {
				lines.push(`- held back: ${heldBack.join(", ")}`);
			}
			lines.push("");
		}
	}

	if (matrix.excluded.length > 0) {
		lines.push("## Excluded claims", "");
		for (const exclusion of matrix.excluded) {
			const subject =
				exclusion.profileId.length > 0
					? `${exclusion.definitionId} → ${exclusion.profileId}`
					: exclusion.definitionId;
			lines.push(`- ${subject}: ${exclusion.code} — ${exclusion.detail}`);
		}
		lines.push("");
	}

	// A single trailing newline, so the file is POSIX-clean and byte-stable.
	return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}
