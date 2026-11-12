// Typed failures for the artifact store and verifier (WP3, C14, D3). Every
// code carries a remediation an operator can act on; none carries a
// credential, a header, or a response body.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

// public-contract: refusal and error codes the artifact store and verifier return.
export const ARTIFACT_REASON = Object.freeze({
	digestInvalid: "artifact-digest-invalid",
	corrupt: "artifact-corrupt",
	missing: "artifact-missing",
	tooLarge: "artifact-too-large",
	backendUnavailable: "artifact-backend-unavailable",
	backendRejected: "artifact-backend-rejected",
	credentialUnavailable: "artifact-credential-unavailable",
	configInvalid: "artifact-store-config-invalid",
	journalConflict: "artifact-journal-conflict",
	coordinateInvalid: "artifact-coordinate-invalid",
	coordinateMutable: "artifact-coordinate-mutable",
	ecosystemUnsupported: "artifact-ecosystem-unsupported",
	registryUnavailable: "artifact-registry-unavailable",
	registryNotFound: "artifact-registry-not-found",
	registryMalformed: "artifact-registry-malformed",
	digestMismatch: "artifact-digest-mismatch",
	digestIncomparable: "artifact-registry-digest-incomparable",
	sizeMismatch: "artifact-size-mismatch",
	unverifiable: "artifact-unverifiable",
} as const);

export type ArtifactReasonCode =
	(typeof ARTIFACT_REASON)[keyof typeof ARTIFACT_REASON];

export function reason(
	code: ArtifactReasonCode,
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

export function refusal(reasons: readonly ReasonRecord[]): Refusal {
	return { ok: false, reasons };
}

/**
 * The store port returns plain values (`ArtifactRef`, bytes, `void`), so a
 * failure is thrown as this error. It carries the same code and remediation a
 * refusal would, and its message is built only from codes, digests and HTTP
 * status numbers, so it is safe to log.
 */
export class ArtifactStoreError extends Error {
	readonly code: ArtifactReasonCode;
	readonly remediation: string;
	readonly subject: string;
	constructor(
		code: ArtifactReasonCode,
		message: string,
		remediation: string,
		subject = "",
	) {
		super(`${code}: ${message}`);
		this.name = "ArtifactStoreError";
		this.code = code;
		this.remediation = remediation;
		this.subject = subject;
	}

	toReason(): ReasonRecord {
		return reason(this.code, this.message, this.remediation, this.subject);
	}
}

export function isArtifactStoreError<E>(
	error: E,
): error is E & ArtifactStoreError {
	return error instanceof ArtifactStoreError;
}

export function corrupt(digest: string, backend: string): ArtifactStoreError {
	return new ArtifactStoreError(
		ARTIFACT_REASON.corrupt,
		`stored bytes for ${digest} on the ${backend} backend do not hash to their digest`,
		"Treat the blob as lost: delete it (`hobo deploy artifacts delete <digest>`) and re-put the original bytes from the build; promotion of Freight that names it stays blocked until then.",
		digest,
	);
}
