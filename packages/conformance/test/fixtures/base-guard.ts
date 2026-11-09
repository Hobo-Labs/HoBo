/**
 * `assertSanitized` as it stood on the base branch (169d87fcf819), copied by a
 * script with only the declarations it reaches, as the oracle the differential
 * test holds the shared detectors to. Not edited by hand; do not import it from src.
 */
import type { TrustEvidence } from "@hobo/trust";

// public-contract: versions portable anonymous-provider trust evidence.
const ANONYMOUS_EVIDENCE_ARTIFACT_SCHEMA =
	"hobo.conformance.anonymous-trust-evidence/v1" as const;

type EvidenceProvenance = {
	readonly adapterVersion: string;
	/** Digest of the Resource Definition this evidence describes. */
	readonly productDefinitionDigest: string;
	/** ISO date a human last read the provider's documented contract. */
	readonly providerDocsCheckedAt: string;
	readonly runTag: string;
	readonly signerId: string;
	readonly suiteIds: readonly string[];
};

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface AnonymousTrustEvidenceArtifact {
	readonly schema: typeof ANONYMOUS_EVIDENCE_ARTIFACT_SCHEMA;
	readonly provenance: EvidenceProvenance;
	readonly evidence: TrustEvidence;
	readonly artifactDigest: string;
	readonly signature: string;
}

class LiveEvidenceError extends Error {
	readonly code:
		| "EVIDENCE_CONTAINS_SECRET"
		| "EVIDENCE_UPGRADES_UNKNOWN"
		| "EVIDENCE_WINDOW_INVALID"
		| "EVIDENCE_PROVENANCE_INVALID";

	constructor(
		code:
			| "EVIDENCE_CONTAINS_SECRET"
			| "EVIDENCE_UPGRADES_UNKNOWN"
			| "EVIDENCE_WINDOW_INVALID"
			| "EVIDENCE_PROVENANCE_INVALID",
		message: string,
	) {
		super(message);
		this.name = "LiveEvidenceError";
		this.code = code;
	}
}

/** Values that must never appear anywhere in an artifact. */
const SECRET_PATTERN: readonly RegExp[] = [
	/postgres(?:ql)?:\/\/[^\s"]*:[^\s"]*@/iu,
	/rediss?:\/\/[^\s"]*:[^\s"]*@/iu,
	/mysql:\/\/[^\s"]*:[^\s"]*@/iu,
	/mongodb(?:\+srv)?:\/\/[^\s"]*:[^\s"]*@/iu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
	/\bBearer\s+[A-Za-z0-9._-]{8,}/iu,
	/\b(?:sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{16,}\b/u,
	/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
	/"(?:password|passwd|secret|apiKey|api_key|accessKey|access_key|token)"\s*:/iu,
];

/**
 * Scan the serialized artifact for credential material.
 *
 * Deliberately a refusal rather than a redaction: if material reached this
 * point, the adapter has a leak that redacting one artifact would hide.
 */
export function assertSanitized(
	artifact: AnonymousTrustEvidenceArtifact,
): void {
	const serialized = JSON.stringify(artifact);
	for (const pattern of SECRET_PATTERN) {
		if (pattern.test(serialized)) {
			throw new LiveEvidenceError(
				"EVIDENCE_CONTAINS_SECRET",
				"the evidence artifact contains credential-shaped material and was not emitted",
			);
		}
	}
}
