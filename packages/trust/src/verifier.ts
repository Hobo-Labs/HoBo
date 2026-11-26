/**
 * Signature verification port.
 *
 * This package deliberately implements no cryptography. It states what a
 * verifier must answer and treats every answer other than `valid` as a reason
 * not to select the provider.
 */
export type EvidenceVerificationRequest = {
	readonly providerId: string;
	readonly productDefinitionId: string;
	/** Digest the signature is over. Recomputed by the caller, never trusted. */
	readonly evidenceDigest: string;
	readonly signature: string;
};

export type EvidenceVerificationOutcome = "valid" | "invalid" | "unknown";

export type EvidenceVerifier = {
	/** Identifies the trust root, so a verdict says *who* vouched. */
	readonly id: string;
	verify(request: EvidenceVerificationRequest): EvidenceVerificationOutcome;
};

/**
 * The verifier used when a caller injects none.
 *
 * It answers `unknown` for everything, which makes "forgot to wire a trust
 * root" indistinguishable from "nobody vouched for this" — both unselectable.
 */
export const UNVERIFIED_EVIDENCE_VERIFIER: EvidenceVerifier = {
	id: "hobo.no-trust-root/v1",
	verify() {
		return "unknown";
	},
};
