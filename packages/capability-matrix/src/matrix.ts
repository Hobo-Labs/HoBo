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

// public-contract: versions serialized capability coverage reports.
export const CAPABILITY_MATRIX_SCHEMA_VERSION = "hobo.capability-matrix/v1";

/**
 * What a cell would resolve to today.
 *
 * The `-only` verdicts exist because "covered" is a claim about public
 * provider-native support. A cell reachable solely through a bridge, solely on
 * infrastructure HoBo runs, or solely by spending sponsor budget is genuinely
 * usable and genuinely not the same thing.
 */
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

/** Definition ids in one bucket, split by whether they are selectable now. */
// domain-view: parsed narrowing of CapabilityMatrixBucketRecord in
// data-models/capability_matrix.proto; both lists are sorted and de-duplicated.
export type CapabilityMatrixBucket = {
	readonly available: readonly string[];
	readonly unavailable: readonly string[];
};

/**
 * The five buckets of one cell. Modelled as named fields rather than a map so
 * that "somebody forgot to report bridges" is a compile error.
 */
// domain-view: parsed narrowing of CapabilityMatrixBucketsRecord in
// data-models/capability_matrix.proto.
export type CapabilityMatrixBuckets = {
	readonly native: CapabilityMatrixBucket;
	readonly pack: CapabilityMatrixBucket;
	readonly bridge: CapabilityMatrixBucket;
	readonly substrate: CapabilityMatrixBucket;
	readonly sponsor: CapabilityMatrixBucket;
};

// domain-view: parsed narrowing of CapabilityMatrixCellRecord in
// data-models/capability_matrix.proto.
export type CapabilityMatrixCell = {
	readonly key: CapabilityMatrixCellKey;
	readonly primitive: BindlePrimitive;
	readonly runtime: BindleRuntime;
	readonly verdict: CoverageVerdict;
	readonly buckets: CapabilityMatrixBuckets;
	readonly candidates: readonly CapabilityMatrixCandidate[];
};

/** Why a declared claim reached no cell at all. */
export const MATRIX_EXCLUSION_CODES = [
	"no-declared-semantics",
	"unregistered-profile",
	"no-runtime-model",
	"unknown-runtime-model",
	"unknown-realization",
] as const;

export type MatrixExclusionCode = (typeof MATRIX_EXCLUSION_CODES)[number];

// domain-view: parsed narrowing of CapabilityMatrixExclusionRecord in
// data-models/capability_matrix.proto.
export type CapabilityMatrixExclusion = {
	readonly definitionId: string;
	readonly profileId: string;
	readonly code: MatrixExclusionCode;
	readonly detail: string;
};

// domain-view: parsed narrowing of CapabilityMatrixRecord in
// data-models/capability_matrix.proto; `cells` is the complete grid, never a
// sparse list of the interesting ones.
export type CapabilityMatrix = {
	readonly schemaVersion: typeof CAPABILITY_MATRIX_SCHEMA_VERSION;
	/** The evaluation instant the caller supplied. Nothing here reads a clock. */
	readonly evaluatedAtMs: number;
	/** Digest of the profile registry the cells were resolved against. */
	readonly profileRegistryDigest: string;
	/** Digest of the trust bundle every candidate's evidence was judged in. */
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

/**
 * Verdict precedence, best-supported first. `sponsor` sits last among the
 * usable outcomes because it is the only one that costs HoBo money to keep
 * true.
 */
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

/** Every definition id registered against a cell, whatever its bucket. */
export function cellDefinitionIds(
	cell: CapabilityMatrixCell,
): readonly string[] {
	const ids = new Set<string>();
	for (const candidate of cell.candidates) ids.add(candidate.definitionId);
	return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The candidates a cell could actually select right now. */
export function availableCandidates(
	cell: CapabilityMatrixCell,
): readonly CapabilityMatrixCandidate[] {
	return cell.candidates.filter((candidate) => candidate.available);
}
