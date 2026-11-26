/**
 * Structured findings over a derived matrix.
 *
 * Nothing here throws. A gap in coverage is a fact about the world, not a
 * programming error, and the caller — a docs job, a release gate, a dashboard —
 * decides which findings it treats as blocking. Throwing would force that
 * decision into this package and make an honest empty matrix unreportable.
 */
import type { BindlePrimitive, BindleRuntime } from "@hobo/capability-profiles";

import { CAPABILITY_MATRIX_COORDINATES } from "./grid.js";
import {
	availableCandidates,
	type CapabilityMatrix,
	type CapabilityMatrixCell,
	COVERAGE_VERDICTS,
	type CoverageVerdict,
} from "./matrix.js";

export const MATRIX_FINDING_CODES = [
	"uncovered-cell",
	"evidence-lapsed-cell",
	"bridge-only-cell",
	"sponsor-only-cell",
	"substrate-only-cell",
	"expiring-evidence-cell",
	"missing-conformance-ref",
] as const;

export type MatrixFindingCode = (typeof MATRIX_FINDING_CODES)[number];

export const MATRIX_FINDING_SEVERITIES = ["error", "warning", "info"] as const;

export type MatrixFindingSeverity = (typeof MATRIX_FINDING_SEVERITIES)[number];

// domain-view: parsed narrowing of CapabilityMatrixFindingRecord in
// data-models/capability_matrix.proto.
export type CapabilityMatrixFinding = {
	readonly code: MatrixFindingCode;
	readonly severity: MatrixFindingSeverity;
	readonly primitive: BindlePrimitive;
	readonly runtime: BindleRuntime;
	readonly detail: string;
	/** The definitions the finding is about. Sorted; may be empty. */
	readonly definitionIds: readonly string[];
};

// domain-view: parsed narrowing of CoverageSummaryRecord in
// data-models/capability_matrix.proto.
export type CoverageSummaryEntry = {
	readonly verdict: CoverageVerdict;
	readonly cells: number;
};

export type CapabilityMatrixValidation = {
	readonly evaluatedAtMs: number;
	readonly matrixDigest: string;
	readonly expiryHorizonMs: number;
	/** One entry per verdict, in the canonical verdict order. */
	readonly summary: readonly CoverageSummaryEntry[];
	readonly findings: readonly CapabilityMatrixFinding[];
};

export type CapabilityMatrixValidationOptions = {
	/**
	 * How far ahead an expiry counts as "expiring". Defaults to seven days,
	 * which is roughly the shortest window in which somebody can notice a
	 * finding and re-run a conformance harness.
	 */
	readonly expiryHorizonMs?: number | undefined;
};

const DEFAULT_EXPIRY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

const SEVERITY_BY_CODE = {
	"uncovered-cell": "warning",
	// A lapse is worse than a gap: this cell used to work.
	"evidence-lapsed-cell": "error",
	"bridge-only-cell": "warning",
	"sponsor-only-cell": "warning",
	"substrate-only-cell": "info",
	"expiring-evidence-cell": "warning",
	// A claim nobody can check is not coverage.
	"missing-conformance-ref": "error",
} as const;

/** Verdicts that are, on their own, worth reporting — and why. */
const VERDICT_FINDINGS = {
	covered: undefined,
	"pack-only": undefined,
	"evidence-lapsed": {
		code: "evidence-lapsed-cell",
		detail:
			"every registered definition for this cell is held back by evidence or conformance state",
	},
	"bridge-only": {
		code: "bridge-only-cell",
		detail:
			"the only selectable coverage is a bridge, which adapts rather than implements the primitive",
	},
	"sponsor-only": {
		code: "sponsor-only-cell",
		detail:
			"the only selectable coverage is sponsor-backed, so it costs HoBo budget to keep true",
	},
	"substrate-only": {
		code: "substrate-only-cell",
		detail:
			"the only selectable coverage runs on infrastructure HoBo operates, not on a public provider",
	},
	uncovered: {
		code: "uncovered-cell",
		detail: "no definition is registered for this primitive on this runtime",
	},
} as const;

function sortedIds(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function expiringFinding(
	cell: CapabilityMatrixCell,
	evaluatedAtMs: number,
	horizonMs: number,
): CapabilityMatrixFinding | undefined {
	const available = availableCandidates(cell);
	if (available.length === 0) return undefined;
	const expiring = available.filter(
		(candidate) =>
			candidate.evidenceExpiresAtMs !== undefined &&
			candidate.evidenceExpiresAtMs - evaluatedAtMs <= horizonMs,
	);
	// Only worth reporting when the whole cell is about to lapse: one expiring
	// candidate beside a healthy one is not a coverage risk.
	if (expiring.length !== available.length) return undefined;
	return {
		code: "expiring-evidence-cell",
		severity: SEVERITY_BY_CODE["expiring-evidence-cell"],
		primitive: cell.primitive,
		runtime: cell.runtime,
		detail: `all ${available.length} selectable candidate(s) carry evidence expiring within ${horizonMs}ms`,
		definitionIds: sortedIds(
			expiring.map((candidate) => candidate.definitionId),
		),
	};
}

function missingConformanceRefFinding(
	cell: CapabilityMatrixCell,
): CapabilityMatrixFinding | undefined {
	const offenders = cell.candidates.filter(
		(candidate) => candidate.conformanceRef === undefined,
	);
	if (offenders.length === 0) return undefined;
	return {
		code: "missing-conformance-ref",
		severity: SEVERITY_BY_CODE["missing-conformance-ref"],
		primitive: cell.primitive,
		runtime: cell.runtime,
		detail:
			"a definition claims this cell without naming a conformance suite, so the claim cannot be checked",
		definitionIds: sortedIds(
			offenders.map((candidate) => candidate.definitionId),
		),
	};
}

/**
 * Report what is wrong with a matrix, as data.
 *
 * The findings are ordered by cell in canonical grid order and then by code, so
 * two runs over equal matrices produce equal reports and a diff of the report
 * is a diff of the coverage.
 */
export function validateCapabilityMatrix(
	matrix: CapabilityMatrix,
	options: CapabilityMatrixValidationOptions = {},
): CapabilityMatrixValidation {
	const expiryHorizonMs = options.expiryHorizonMs ?? DEFAULT_EXPIRY_HORIZON_MS;
	const findings: CapabilityMatrixFinding[] = [];
	const counts = new Map<CoverageVerdict, number>(
		COVERAGE_VERDICTS.map((verdict) => [verdict, 0]),
	);
	const cellByKey = new Map(matrix.cells.map((cell) => [cell.key, cell]));

	for (const coordinate of CAPABILITY_MATRIX_COORDINATES) {
		const cell = cellByKey.get(coordinate.key);
		if (cell === undefined) continue;
		counts.set(cell.verdict, (counts.get(cell.verdict) ?? 0) + 1);

		const verdictFinding = VERDICT_FINDINGS[cell.verdict];
		if (verdictFinding !== undefined) {
			findings.push({
				code: verdictFinding.code,
				severity: SEVERITY_BY_CODE[verdictFinding.code],
				primitive: cell.primitive,
				runtime: cell.runtime,
				detail: verdictFinding.detail,
				definitionIds: sortedIds(
					cell.candidates.map((candidate) => candidate.definitionId),
				),
			});
		}

		const expiring = expiringFinding(
			cell,
			matrix.evaluatedAtMs,
			expiryHorizonMs,
		);
		if (expiring !== undefined) findings.push(expiring);

		const unverifiable = missingConformanceRefFinding(cell);
		if (unverifiable !== undefined) findings.push(unverifiable);
	}

	return {
		evaluatedAtMs: matrix.evaluatedAtMs,
		matrixDigest: matrix.digest,
		expiryHorizonMs,
		summary: COVERAGE_VERDICTS.map((verdict) => ({
			verdict,
			cells: counts.get(verdict) ?? 0,
		})),
		findings,
	};
}

/** The findings a caller would normally refuse to ship on. */
export function blockingFindings(
	validation: CapabilityMatrixValidation,
): readonly CapabilityMatrixFinding[] {
	return validation.findings.filter((finding) => finding.severity === "error");
}
