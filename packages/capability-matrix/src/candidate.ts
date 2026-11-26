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

export const CANDIDATE_BUCKETS = [
	"native",
	"pack",
	"bridge",
	"substrate",
	"sponsor",
] as const;

export type CandidateBucket = (typeof CANDIDATE_BUCKETS)[number];

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

// domain-view:
export type CapabilityMatrixCandidate = {
	readonly primitive: BindlePrimitive;
	readonly runtime: BindleRuntime;
	readonly definitionId: string;
	readonly providerId: string;
	readonly profileId: string;
	readonly realization: RealizationKind;
	readonly bucket: CandidateBucket;
	readonly available: boolean;
	readonly evidenceState: EvidenceFreshnessState;
	readonly evidenceExpiresAtMs?: number | undefined;
	readonly conformance: "pass" | "fail" | "unknown";
	readonly conformanceRef?: string | undefined;
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
