/**
 * The trust gate.
 *
 * Pure and fail-closed: absent, unparseable, unsigned, digest-mismatched,
 * expired, stale, or `unknown`-checked evidence all produce the same answer —
 * not selectable. "We did not test it" is never "it works".
 */
import { REJECTION_CODES, type RejectionCode } from "@hobo/capability-profiles";

import { sha256Of } from "./canonical.js";
import {
	computeEvidenceDigest,
	type EvidenceCheckOutcome,
	STANDARD_TRUST_CHECKS,
	type TrustEvidence,
} from "./evidence.js";
import type { TrustRequirement } from "./requirement.js";
import {
	type EvidenceVerificationOutcome,
	type EvidenceVerifier,
	UNVERIFIED_EVIDENCE_VERIFIER,
} from "./verifier.js";

/** Trust-specific reasons, on top of the shared selection rejection codes. */
export const TRUST_ONLY_REASON_CODES = [
	"EVIDENCE_ABSENT",
	"EVIDENCE_UNSIGNED",
	"EVIDENCE_DIGEST_MISMATCH",
] as const;

export const TRUST_REASON_CODES = [
	...REJECTION_CODES,
	...TRUST_ONLY_REASON_CODES,
] as const;

export type TrustReasonCode =
	| RejectionCode
	| (typeof TRUST_ONLY_REASON_CODES)[number];

// parallel-type-allowed: the in-memory reason with a TrustReasonCode union drawn from @hobo/capability-profiles' REJECTION_CODES; hobo.trust.v1.TrustReason widens the code to a string for the wire.
export type TrustReason = {
	readonly code: TrustReasonCode;
	readonly detail: string;
};

// public-contract: durable trust verdict schema identifier shared by evaluators and consumers.
export const TRUST_VERDICT_SCHEMA_VERSION = "hobo.trust-verdict/v1";

// parallel-type-allowed: the verdict as evaluateTrust constructs it — the only constructor — with genuinely optional evidence facts that the wire message models as explicit-presence fields; hobo.trust.v1.TrustVerdict is its projection.
export type TrustVerdict = {
	readonly schemaVersion: typeof TRUST_VERDICT_SCHEMA_VERSION;
	/** True only when every gate passed. Operator overrides never set this. */
	readonly selectable: boolean;
	readonly providerId: string;
	readonly productDefinitionId: string;
	readonly adapterVersion: string;
	readonly evaluatedAtMs: number;
	readonly verifierId: string;
	readonly signatureOutcome: EvidenceVerificationOutcome;
	readonly evidenceDigest?: string;
	readonly evidenceAgeMs?: number;
	readonly expiresAtMs?: number;
	/** Sorted by code then detail so equal facts serialize identically. */
	readonly reasons: readonly TrustReason[];
	/** Deterministic digest of the verdict body, for audit joins. */
	readonly verdictDigest: string;
};

const PROVIDER_CLASS_RANK: Readonly<Record<string, number>> = {
	established: 0,
	"verified-emerging": 1,
	experimental: 2,
};

const ROTATABLE_AUTHORITIES: readonly string[] = [
	"absent",
	"rotatable",
	"reauthorization-required",
];

function checkOutcome(
	evidence: TrustEvidence,
	key: string,
): EvidenceCheckOutcome | undefined {
	return evidence.checks[key];
}

function requireCheck(
	evidence: TrustEvidence,
	key: string,
	code: TrustReasonCode,
	subject: string,
	push: (reason: TrustReason) => void,
): void {
	const outcome = checkOutcome(evidence, key);
	if (outcome === "pass") return;
	push({
		code,
		detail:
			outcome === undefined
				? `${subject} check ${key} is absent from the evidence`
				: `${subject} check ${key} is ${outcome}`,
	});
}

function verdictDigestOf(
	body: Omit<TrustVerdict, "verdictDigest" | "schemaVersion">,
): string {
	return sha256Of({
		schemaVersion: TRUST_VERDICT_SCHEMA_VERSION,
		selectable: body.selectable,
		providerId: body.providerId,
		productDefinitionId: body.productDefinitionId,
		adapterVersion: body.adapterVersion,
		evaluatedAtMs: body.evaluatedAtMs,
		verifierId: body.verifierId,
		signatureOutcome: body.signatureOutcome,
		evidenceDigest: body.evidenceDigest,
		evidenceAgeMs: body.evidenceAgeMs,
		expiresAtMs: body.expiresAtMs,
		reasons: body.reasons.map((reason) => ({
			code: reason.code,
			detail: reason.detail,
		})),
	});
}

/**
 * Evaluate evidence against a requirement at an explicit instant.
 *
 * `nowMs` is an argument, not a clock read, so the same inputs always produce
 * the same verdict and a replayed decision can be re-derived years later.
 */
export function evaluateTrust(
	evidence: TrustEvidence | undefined,
	requirement: TrustRequirement,
	nowMs: number,
	verifier: EvidenceVerifier = UNVERIFIED_EVIDENCE_VERIFIER,
): TrustVerdict {
	const reasons: TrustReason[] = [];
	const push = (reason: TrustReason): void => {
		reasons.push(reason);
	};

	if (evidence === undefined) {
		const body = {
			selectable: false,
			providerId: "",
			productDefinitionId: "",
			adapterVersion: "",
			evaluatedAtMs: nowMs,
			verifierId: verifier.id,
			signatureOutcome: "unknown" as EvidenceVerificationOutcome,
			reasons: [
				{
					code: "EVIDENCE_ABSENT" as TrustReasonCode,
					detail: "no trust evidence was recorded for this provider adapter",
				},
			],
		};
		return {
			schemaVersion: TRUST_VERDICT_SCHEMA_VERSION,
			...body,
			verdictDigest: verdictDigestOf(body),
		};
	}

	// A digest that does not describe the body means the signature, whatever it
	// covers, does not cover this record.
	const recomputed = computeEvidenceDigest(evidence);
	const digestMatches = recomputed === evidence.evidenceDigest;
	if (!digestMatches) {
		push({
			code: "EVIDENCE_DIGEST_MISMATCH",
			detail: `evidence digest ${evidence.evidenceDigest} does not match the recomputed ${recomputed}`,
		});
	}

	const signatureOutcome = digestMatches
		? verifier.verify({
				providerId: evidence.providerId,
				productDefinitionId: evidence.productDefinitionId,
				evidenceDigest: recomputed,
				signature: evidence.signature,
			})
		: ("invalid" as EvidenceVerificationOutcome);
	if (signatureOutcome !== "valid") {
		push({
			code: "EVIDENCE_UNSIGNED",
			detail: `signature verification by ${verifier.id} returned ${signatureOutcome}`,
		});
	}

	const evidenceAgeMs = nowMs - evidence.testedAt;
	if (evidenceAgeMs < 0) {
		push({
			code: "EVIDENCE_STALE",
			detail: `evidence is dated ${evidence.testedAt} which is after the evaluation instant ${nowMs}`,
		});
	} else if (evidenceAgeMs > requirement.maximumEvidenceAgeMs) {
		push({
			code: "EVIDENCE_STALE",
			detail: `evidence is ${evidenceAgeMs}ms old, above the ${requirement.maximumEvidenceAgeMs}ms maximum`,
		});
	}
	if (evidence.expiresAt <= nowMs) {
		push({
			code: "EVIDENCE_STALE",
			detail: `evidence expired at ${evidence.expiresAt}`,
		});
	}

	// Any failed or unknown check gates, whether or not the requirement names it.
	for (const key of Object.keys(evidence.checks)) {
		const outcome = evidence.checks[key];
		if (outcome === "pass") continue;
		push({
			code: "CONFORMANCE_FAILED",
			detail: `check ${key} is ${String(outcome)}`,
		});
	}
	for (const key of requirement.requiredChecks) {
		if (checkOutcome(evidence, key) === undefined) {
			push({
				code: "CONFORMANCE_FAILED",
				detail: `required check ${key} is absent from the evidence`,
			});
		}
	}

	if (requirement.requireOfficialBootstrapContract) {
		requireCheck(
			evidence,
			STANDARD_TRUST_CHECKS.officialBootstrapContract,
			"BOOTSTRAP_POLICY_DENIED",
			"official bootstrap contract",
			push,
		);
	}
	if (requirement.requireDocumentedClaimContract) {
		requireCheck(
			evidence,
			STANDARD_TRUST_CHECKS.documentedClaimContract,
			"CLAIM_MODE_INSUFFICIENT",
			"documented claim contract",
			push,
		);
	}
	if (requirement.requireStandardBinding) {
		requireCheck(
			evidence,
			STANDARD_TRUST_CHECKS.standardBinding,
			"BINDING_UNAVAILABLE",
			"standard binding",
			push,
		);
	}
	if (requirement.requireExportProfile) {
		requireCheck(
			evidence,
			STANDARD_TRUST_CHECKS.exportProfile,
			"MIGRATION_REQUIRED_BUT_UNAVAILABLE",
			"export profile",
			push,
		);
	}

	const candidateRank = PROVIDER_CLASS_RANK[evidence.providerClass];
	const minimumRank = PROVIDER_CLASS_RANK[requirement.minimumProviderClass];
	if (
		candidateRank === undefined ||
		minimumRank === undefined ||
		candidateRank > minimumRank
	) {
		push({
			code: "PROVIDER_MATURITY_DENIED",
			detail: `provider class ${evidence.providerClass} is below the required minimum ${requirement.minimumProviderClass}`,
		});
	}

	if (
		requirement.creatorAuthorityAfterClaim === "must-be-absent" &&
		evidence.creatorAuthorityAfterClaim !== "absent"
	) {
		push({
			code: "STRONG_CLAIM_REQUIRED",
			detail: `creator authority after claim is ${evidence.creatorAuthorityAfterClaim}; policy requires absent`,
		});
	}
	if (
		requirement.creatorAuthorityAfterClaim === "must-be-rotatable" &&
		!ROTATABLE_AUTHORITIES.includes(evidence.creatorAuthorityAfterClaim)
	) {
		push({
			code: "STRONG_CLAIM_REQUIRED",
			detail: `creator authority after claim is ${evidence.creatorAuthorityAfterClaim} and cannot be rotated away`,
		});
	}

	if (evidence.claimActionCount > requirement.maximumClaimActions) {
		push({
			code: "TOO_MANY_CLAIM_ACTIONS",
			detail: `${evidence.claimActionCount} human claim actions exceeds the maximum ${requirement.maximumClaimActions}`,
		});
	}

	// Realization and sponsor facts must be *stated* to be permitted; silence is
	// not consent when the requirement narrows them.
	if (!requirement.allowPack || !requirement.allowBridge) {
		if (evidence.realizations === undefined) {
			push({
				code: "REALIZATION_DENIED",
				detail:
					"evidence does not state which realization kinds the adapter uses, and the requirement restricts them",
			});
		} else {
			if (!requirement.allowPack && evidence.realizations.includes("pack")) {
				push({
					code: "REALIZATION_DENIED",
					detail: "pack realization is not allowed",
				});
			}
			if (
				!requirement.allowBridge &&
				evidence.realizations.includes("bridge")
			) {
				push({
					code: "REALIZATION_DENIED",
					detail: "bridge realization is not allowed",
				});
			}
		}
	}
	if (!requirement.allowSponsor) {
		if (evidence.sponsorBacked === undefined) {
			push({
				code: "BOOTSTRAP_POLICY_DENIED",
				detail:
					"evidence does not state whether the bootstrap path is sponsor-backed, and sponsorship is not allowed",
			});
		} else if (evidence.sponsorBacked) {
			push({
				code: "BOOTSTRAP_POLICY_DENIED",
				detail:
					"sponsor-backed bootstrap is not allowed by the trust requirement",
			});
		}
	}

	const sorted = [...reasons].sort(
		(a, b) => a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail),
	);
	const body = {
		selectable: sorted.length === 0,
		providerId: evidence.providerId,
		productDefinitionId: evidence.productDefinitionId,
		adapterVersion: evidence.adapterVersion,
		evaluatedAtMs: nowMs,
		verifierId: verifier.id,
		signatureOutcome,
		evidenceDigest: evidence.evidenceDigest,
		evidenceAgeMs,
		expiresAtMs: evidence.expiresAt,
		reasons: sorted,
	};
	return {
		schemaVersion: TRUST_VERDICT_SCHEMA_VERSION,
		...body,
		verdictDigest: verdictDigestOf(body),
	};
}
