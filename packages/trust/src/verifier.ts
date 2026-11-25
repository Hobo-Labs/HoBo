export type EvidenceVerificationRequest = {
	readonly providerId: string;
	readonly productDefinitionId: string;
	readonly evidenceDigest: string;
	readonly signature: string;
};

export type EvidenceVerificationOutcome = "valid" | "invalid" | "unknown";

export type EvidenceVerifier = {
	readonly id: string;
	verify(request: EvidenceVerificationRequest): EvidenceVerificationOutcome;
};

export const UNVERIFIED_EVIDENCE_VERIFIER: EvidenceVerifier = {
	id: "hobo.no-trust-root/v1",
	verify() {
		return "unknown";
	},
};
