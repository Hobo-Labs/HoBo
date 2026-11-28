import type { TrustPolicy } from "@hobo/capability-profiles";

import { sha256Of } from "./canonical.js";
import {
	evaluateTrust,
	type TrustReason,
	type TrustVerdict,
} from "./evaluate.js";
import type { TrustEvidence } from "./evidence.js";
import type { TrustRequirement } from "./requirement.js";
import {
	type EvidenceVerifier,
	UNVERIFIED_EVIDENCE_VERIFIER,
} from "./verifier.js";

// public-contract: aggregate trust gate result schema identifier consumed by selection.
export const TRUST_BUNDLE_SCHEMA_VERSION = "hobo.trust-bundle-verdict/v1";

export type EvidenceFreshnessState =
	| "fresh"
	| "absent"
	| "future-dated"
	| "aged"
	| "expired";

// parallel-type-allowed: the freshness answer as evaluateEvidenceFreshness constructs it, with a closed EvidenceFreshnessState union and optional instants; hobo.trust.v1.EvidenceFreshness is its wire projection.
export type EvidenceFreshness = {
	readonly state: EvidenceFreshnessState;
	readonly fresh: boolean;
	readonly detail: string;
	readonly ageMs?: number;
	readonly expiresAtMs?: number;
	readonly remainingMs?: number;
};

export function evaluateEvidenceFreshness(
	evidence: TrustEvidence | undefined,
	nowMs: number,
	maximumAgeMs: number,
): EvidenceFreshness {
	if (evidence === undefined) {
		return {
			state: "absent",
			fresh: false,
			detail: "no trust evidence was recorded",
		};
	}
	const ageMs = nowMs - evidence.testedAt;
	if (ageMs < 0) {
		return {
			state: "future-dated",
			fresh: false,
			detail: `evidence is dated ${evidence.testedAt}, after the evaluation instant ${nowMs}`,
			ageMs,
			expiresAtMs: evidence.expiresAt,
		};
	}
	if (evidence.expiresAt <= nowMs) {
		return {
			state: "expired",
			fresh: false,
			detail: `evidence expired at ${evidence.expiresAt}`,
			ageMs,
			expiresAtMs: evidence.expiresAt,
			remainingMs: 0,
		};
	}
	if (ageMs > maximumAgeMs) {
		return {
			state: "aged",
			fresh: false,
			detail: `evidence is ${ageMs}ms old, above the ${maximumAgeMs}ms maximum`,
			ageMs,
			expiresAtMs: evidence.expiresAt,
			remainingMs: evidence.expiresAt - nowMs,
		};
	}
	return {
		state: "fresh",
		fresh: true,
		detail: `evidence is ${ageMs}ms old and valid for another ${evidence.expiresAt - nowMs}ms`,
		ageMs,
		expiresAtMs: evidence.expiresAt,
		remainingMs: evidence.expiresAt - nowMs,
	};
}

export type TrustBundleSubject = {
	readonly subjectId: string;
	readonly evidence?: TrustEvidence;
};

// parallel-type-allowed: one subject's answer inside a bundle, produced only by evaluateTrustBundle from already-parsed evidence; hobo.trust.v1.TrustBundleSubjectVerdict is its wire projection.
export type TrustBundleSubjectVerdict = {
	readonly subjectId: string;
	readonly verdict: TrustVerdict;
	readonly freshness: EvidenceFreshness;
};

export type TrustBundleReason = TrustReason & { readonly subjectId: string };

// parallel-type-allowed: the whole-solution answer, produced only by evaluateTrustBundle so that bundleDigest is always the digest of these exact subjects; hobo.trust.v1.TrustBundleVerdict is its wire projection.
export type TrustBundleVerdict = {
	readonly schemaVersion: typeof TRUST_BUNDLE_SCHEMA_VERSION;
	readonly selectable: boolean;
	readonly evaluatedAtMs: number;
	readonly verifierId: string;
	readonly subjects: readonly TrustBundleSubjectVerdict[];
	readonly reasons: readonly TrustBundleReason[];
	readonly bundleDigest: string;
};

export type TrustBundleInput = {
	readonly subjects: readonly TrustBundleSubject[];
	readonly requirement: TrustRequirement;
	readonly nowMs: number;
	readonly verifier?: EvidenceVerifier;
};

export function evaluateTrustBundle(
	input: TrustBundleInput,
): TrustBundleVerdict {
	const verifier = input.verifier ?? UNVERIFIED_EVIDENCE_VERIFIER;
	const seen = new Set<string>();
	const ordered = [...input.subjects].sort((a, b) =>
		a.subjectId.localeCompare(b.subjectId),
	);

	const subjects: TrustBundleSubjectVerdict[] = [];
	const reasons: TrustBundleReason[] = [];
	for (const subject of ordered) {
		if (seen.has(subject.subjectId)) continue;
		seen.add(subject.subjectId);
		const verdict = evaluateTrust(
			subject.evidence,
			input.requirement,
			input.nowMs,
			verifier,
		);
		const freshness = evaluateEvidenceFreshness(
			subject.evidence,
			input.nowMs,
			input.requirement.maximumEvidenceAgeMs,
		);
		subjects.push({ subjectId: subject.subjectId, verdict, freshness });
		for (const reason of verdict.reasons) {
			reasons.push({
				subjectId: subject.subjectId,
				code: reason.code,
				detail: reason.detail,
			});
		}
	}

	const sortedReasons = [...reasons].sort(
		(a, b) =>
			a.subjectId.localeCompare(b.subjectId) ||
			a.code.localeCompare(b.code) ||
			a.detail.localeCompare(b.detail),
	);
	const bundleDigest = sha256Of({
		schemaVersion: TRUST_BUNDLE_SCHEMA_VERSION,
		evaluatedAtMs: input.nowMs,
		verifierId: verifier.id,
		subjects: subjects.map((entry) => ({
			subjectId: entry.subjectId,
			verdictDigest: entry.verdict.verdictDigest,
			freshness: entry.freshness.state,
		})),
	});

	return {
		schemaVersion: TRUST_BUNDLE_SCHEMA_VERSION,
		selectable:
			subjects.length > 0 &&
			subjects.every((entry) => entry.verdict.selectable),
		evaluatedAtMs: input.nowMs,
		verifierId: verifier.id,
		subjects,
		reasons: sortedReasons,
		bundleDigest,
	};
}

export type TrustPolicyBridgeOptions = {
	readonly sponsorBudgetMinorUnits?: number;
};

export function trustPolicyFromRequirement(
	requirement: TrustRequirement,
	options: TrustPolicyBridgeOptions = {},
): TrustPolicy {
	const sponsorBudgetMinorUnits = options.sponsorBudgetMinorUnits ?? 0;
	return {
		minimumProviderClass: requirement.minimumProviderClass,
		creatorAuthorityAfterClaim: requirement.creatorAuthorityAfterClaim,
		maximumClaimActions: requirement.maximumClaimActions,
		maximumEvidenceAgeMs: requirement.maximumEvidenceAgeMs,
		requireExportProfile: requirement.requireExportProfile,
		allowSponsor: requirement.allowSponsor && sponsorBudgetMinorUnits > 0,
		allowPack: requirement.allowPack,
		allowBridge: requirement.allowBridge,
		sponsorBudgetMinorUnits,
	};
}
