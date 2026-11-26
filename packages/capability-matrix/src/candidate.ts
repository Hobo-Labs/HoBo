/**
 * One registered definition's claim on one cell, and why it is or is not
 * usable right now.
 *
 * A candidate is never authored. It is projected from a Resource Definition's
 * declared semantics plus the trust evidence that definition points at, which
 * is why `bucket` and `available` are derived here instead of accepted from a
 * caller: a catalog entry can state that it is a pack on generic compute, it
 * cannot state that it counts as public provider-native coverage.
 */
import type {
	BindlePrimitive,
	BindleRuntime,
	RealizationKind,
} from "@hobo/capability-profiles";
import type { EvidenceFreshnessState } from "@hobo/trust";

/**
 * The five things a cell may be covered by, kept apart because conflating them
 * is the specific dishonesty this package exists to prevent.
 *
 * - `native` — a public provider implements the primitive itself.
 * - `pack` — HoBo deploys a portable implementation onto generic compute.
 * - `bridge` — the primitive is reached through an adapting shim.
 * - `substrate` — the resource runs on infrastructure HoBo itself operates.
 * - `sponsor` — the bootstrap path spends HoBo sponsor budget.
 */
export const CANDIDATE_BUCKETS = [
	"native",
	"pack",
	"bridge",
	"substrate",
	"sponsor",
] as const;

export type CandidateBucket = (typeof CANDIDATE_BUCKETS)[number];

/**
 * Why a candidate cannot be selected automatically.
 *
 * Every code is a fact about evidence or conformance, never about preference:
 * a candidate is not demoted for being slow or expensive, only for being
 * unproven.
 */
export const CANDIDATE_UNAVAILABILITY_CODES = [
	"evidence-absent",
	"evidence-expired",
	"evidence-aged",
	"evidence-future-dated",
	"trust-gate-failed",
	"conformance-not-passing",
	"conformance-ref-missing",
] as const;

export type CandidateUnavailabilityCode =
	(typeof CANDIDATE_UNAVAILABILITY_CODES)[number];

export type CandidateUnavailability = {
	readonly code: CandidateUnavailabilityCode;
	readonly detail: string;
};

// domain-view: parsed narrowing of CapabilityMatrixCandidateRecord in
// data-models/capability_matrix.proto — closed vocabularies plus the derived
// bucket and availability the wire form carries as plain strings.
export type CapabilityMatrixCandidate = {
	readonly primitive: BindlePrimitive;
	readonly runtime: BindleRuntime;
	readonly definitionId: string;
	readonly providerId: string;
	readonly profileId: string;
	readonly realization: RealizationKind;
	readonly bucket: CandidateBucket;
	/** True only when trust, freshness, and conformance all pass. */
	readonly available: boolean;
	readonly evidenceState: EvidenceFreshnessState;
	readonly evidenceExpiresAtMs?: number | undefined;
	readonly conformance: "pass" | "fail" | "unknown";
	/** Absent when the implementation claim names no conformance suite. */
	readonly conformanceRef?: string | undefined;
	/** Empty exactly when `available` is true. Sorted, so it digests stably. */
	readonly unavailability: readonly CandidateUnavailability[];
};

const BUCKET_RANK = {
	native: 0,
	pack: 1,
	bridge: 2,
	substrate: 3,
	sponsor: 4,
} satisfies Readonly<Record<CandidateBucket, number>>;

/**
 * Assign the single bucket a candidate belongs to.
 *
 * Precedence is deliberate and runs from the strongest caveat down. Money
 * first: a sponsor-backed path works, but counting it as provider-native would
 * describe HoBo's budget as market coverage. HoBo-operated substrate next, for
 * the same reason at one remove. Only a candidate carrying neither caveat is
 * described by its realization kind alone.
 */
export function classifyCandidateBucket(input: {
	readonly realization: RealizationKind;
	readonly sponsorExposureMinorUnits: number;
	readonly hoboOperatedSubstrate: boolean;
}): CandidateBucket {
	if (input.sponsorExposureMinorUnits > 0) return "sponsor";
	if (input.hoboOperatedSubstrate) return "substrate";
	return input.realization;
}

/** Map a trust freshness state onto the reason a candidate is held back. */
export function unavailabilityForEvidenceState(
	state: EvidenceFreshnessState,
): CandidateUnavailabilityCode | undefined {
	switch (state) {
		case "fresh":
			return undefined;
		case "absent":
			return "evidence-absent";
		case "expired":
			return "evidence-expired";
		case "aged":
			return "evidence-aged";
		case "future-dated":
			return "evidence-future-dated";
	}
}

/** Total order over candidates. No key depends on catalog registration order. */
export function compareCandidates(
	a: CapabilityMatrixCandidate,
	b: CapabilityMatrixCandidate,
): number {
	const bucket = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
	if (bucket !== 0) return bucket;
	if (a.available !== b.available) return a.available ? -1 : 1;
	if (a.definitionId !== b.definitionId) {
		return a.definitionId < b.definitionId ? -1 : 1;
	}
	if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
	return 0;
}
