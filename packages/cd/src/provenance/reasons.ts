// Refusal codes the provenance verifier returns. Every one is fail-closed and
// carries a remediation; none echoes a token, a key or a bundle body.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

// public-contract: refusal codes of the provenance verifier.
export const PROVENANCE_REASON = Object.freeze({
	unsigned: "provenance-unsigned",
	bundleInvalid: "provenance-bundle-invalid",
	verifierUnconfigured: "provenance-verifier-unconfigured",
	payloadMismatch: "provenance-payload-mismatch",
	signatureInvalid: "provenance-signature-invalid",
	signerUntrusted: "provenance-signer-untrusted",
	issuerUntrusted: "provenance-issuer-untrusted",
	statementInvalid: "provenance-statement-invalid",
	builderUntrusted: "provenance-builder-untrusted",
	subjectMismatch: "provenance-subject-mismatch",
} as const);

export type ProvenanceReasonCode =
	(typeof PROVENANCE_REASON)[keyof typeof PROVENANCE_REASON];

const REMEDIATION = {
	"provenance-unsigned":
		"Attach the build's Sigstore bundle (or a HoBo-signed attestation JWT) to the statement; unsigned provenance is never trusted.",
	"provenance-bundle-invalid":
		"Send the bundle exactly as the signer produced it (a Sigstore bundle JSON, v0.1–v0.3, or a compact HoBo attestation JWT).",
	"provenance-verifier-unconfigured":
		"Configure the trust policy for this kind of signature (sigstore.trustedRoot + sigstore.issuers, or hoboJwt.jwks/issuer/audience).",
	"provenance-payload-mismatch":
		"Send the statement the bundle signed, byte for byte; a re-serialized or edited statement no longer matches its signature.",
	"provenance-signature-invalid":
		"Do not trust this attestation: its signature, certificate chain or transparency evidence did not verify against the trust policy.",
	"provenance-signer-untrusted":
		"Pin the expected signer identity (certificate SAN, e.g. the release workflow ref) in the subscription or trust policy, or investigate who signed this.",
	"provenance-issuer-untrusted":
		"Add the OIDC issuer that minted the signing certificate to sigstore.issuers if it is legitimately yours.",
	"provenance-statement-invalid":
		"Produce an in-toto Statement v1 with an SLSA provenance v1 predicate, a builder.id, and sha256 subject digests.",
	"provenance-builder-untrusted":
		"Pin the builder id that produced this artifact in the subscription or trust policy, or rebuild on a trusted builder.",
	"provenance-subject-mismatch":
		"Attest exactly the artifacts the Freight carries: every statement subject digest must be an artifact digest and vice versa.",
} as const satisfies Readonly<Record<ProvenanceReasonCode, string>>;

export function provenanceReason(
	code: ProvenanceReasonCode,
	message: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: REMEDIATION[code],
		subject,
	});
}

export function refuseProvenance(
	code: ProvenanceReasonCode,
	message: string,
	subject = "",
): Refusal {
	return { ok: false, reasons: [provenanceReason(code, message, subject)] };
}
