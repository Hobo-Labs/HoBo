/**
 * The derived matrix and the vocabulary its cells speak.
 *
 * A cell answers two different questions and keeps the answers apart: *what is
 * registered here* (five buckets of definition ids) and *what could be selected
 * automatically right now* (one verdict). The second is a function of the
 * first plus evidence state, so coverage can regress without anything being
 * deleted from the catalog.
 */
import type { BindlePrimitive, BindleRuntime } from "@hobo/capability-profiles";

import type {
	CandidateBucket,
	CapabilityMatrixCandidate,
} from "./candidate.js";
import type { CapabilityMatrixCellKey } from "./grid.js";

export const CAPABILITY_MATRIX_SCHEMA_VERSION = "hobo.capability-matrix/v1";

export const COVERAGE_VERDICTS = [
	"covered",
	"pack-only",
	"substrate-only",
	"bridge-only",
	"sponsor-only",
	"evidence-lapsed",
	"uncovered",
] as const;

export type CoverageVerdict = (typeof COVERAGE_VERDICTS)[number];

// domain-view: parsed narrowing of CapabilityMatrixBucketRecord in
export type CapabilityMatrixBucket = {
	readonly available: readonly string[];
	readonly unavailable: readonly string[];
};

// domain-view: parsed narrowing of CapabilityMatrixBucketsRecord in
export type CapabilityMatrixBuckets = {
	readonly native: CapabilityMatrixBucket;
	readonly pack: CapabilityMatrixBucket;
	readonly bridge: CapabilityMatrixBucket;
	readonly substrate: CapabilityMatrixBucket;
	readonly sponsor: CapabilityMatrixBucket;
};

// domain-view: parsed narrowing of CapabilityMatrixCellRecord in
export type CapabilityMatrixCell = {
	readonly key: CapabilityMatrixCellKey;
	readonly primitive: BindlePrimitive;
	readonly runtime: BindleRuntime;
	readonly verdict: CoverageVerdict;
	readonly buckets: CapabilityMatrixBuckets;
	readonly candidates: readonly CapabilityMatrixCandidate[];
};

export const MATRIX_EXCLUSION_CODES = [
	"no-declared-semantics",
	"unregistered-profile",
	"no-runtime-model",
	"unknown-runtime-model",
	"unknown-realization",
] as const;

export type MatrixExclusionCode = (typeof MATRIX_EXCLUSION_CODES)[number];

// domain-view: parsed narrowing of CapabilityMatrixExclusionRecord in
export type CapabilityMatrixExclusion = {
	readonly definitionId: string;
	readonly profileId: string;
	readonly code: MatrixExclusionCode;
	readonly detail: string;
};

// domain-view: parsed narrowing of CapabilityMatrixRecord in
export type CapabilityMatrix = {
	readonly schemaVersion: typeof CAPABILITY_MATRIX_SCHEMA_VERSION;
	readonly evaluatedAtMs: number;
	readonly profileRegistryDigest: string;
	readonly trustBundleDigest: string;
	readonly cells: readonly CapabilityMatrixCell[];
	readonly excluded: readonly CapabilityMatrixExclusion[];
	readonly digest: string;
};

export const EMPTY_BUCKET: CapabilityMatrixBucket = {
	available: [],
	unavailable: [],
};

export const EMPTY_BUCKETS: CapabilityMatrixBuckets = {
	native: EMPTY_BUCKET,
	pack: EMPTY_BUCKET,
	bridge: EMPTY_BUCKET,
	substrate: EMPTY_BUCKET,
	sponsor: EMPTY_BUCKET,
};

const VERDICT_BY_BUCKET: readonly (readonly [
	CandidateBucket,
	CoverageVerdict,
])[] = [
	["native", "covered"],
	["pack", "pack-only"],
	["substrate", "substrate-only"],
	["bridge", "bridge-only"],
	["sponsor", "sponsor-only"],
];

/**
 * Reduce a cell's buckets to a single verdict.
 *
 * The distinction that matters is between a cell nobody ever registered
 * anything for (`uncovered`) and a cell that had coverage until its evidence
 * went stale (`evidence-lapsed`). Reporting both as "uncovered" would hide a
 * regression inside a permanent gap.
 */
export function deriveCoverageVerdict(
	buckets: CapabilityMatrixBuckets,
): CoverageVerdict {
	for (const [bucket, verdict] of VERDICT_BY_BUCKET) {
		if (buckets[bucket].available.length > 0) return verdict;
	}
	const hasGatedCandidate = VERDICT_BY_BUCKET.some(
		([bucket]) => buckets[bucket].unavailable.length > 0,
	);
	return hasGatedCandidate ? "evidence-lapsed" : "uncovered";
}

export function cellDefinitionIds(
	cell: CapabilityMatrixCell,
): readonly string[] {
	const ids = new Set<string>();
	for (const candidate of cell.candidates) ids.add(candidate.definitionId);
	return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function availableCandidates(
	cell: CapabilityMatrixCell,
): readonly CapabilityMatrixCandidate[] {
	return cell.candidates.filter((candidate) => candidate.available);
}
