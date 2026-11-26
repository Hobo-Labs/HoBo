import { create } from "@bufbuild/protobuf";
import {
	type ReasonStructuredDetail,
	ReasonStructuredDetailSchema,
} from "../_generated/cd_pb.js";
import {
	isSingleLineBounded,
	isValidReleaseFreightCredentialRef,
	isValidReleaseFreightScope,
} from "./release-freight-detail.js";

// public-contract: closed ReasonStructuredDetail.detailKind values for OCI registry refusals.
export const RELEASE_OCI_DETAIL_KINDS = [
	"oci-upload-foreign-host",
	"oci-upload-path",
	"oci-http-status",
	"oci-blob-size",
	"oci-blob-not-observed",
	"oci-credential-refused",
] as const;

export type ReleaseOciDetailKind = (typeof RELEASE_OCI_DETAIL_KINDS)[number];

const OCI_UPLOAD_PATH_SCOPE = "blob-upload-path";
const OCI_BLOB_SIZE_SCOPE = "over-transport-bound";
const OCI_BLOB_NOT_OBSERVED_SCOPE = "post-upload";

// Closed DNS hostname. data-models/reconcile.cue ANDs `^.{1,253}$` with the
// label pattern because CUE's RE2 rejects the length lookahead.
const OCI_REGISTRY_HOST =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const OCI_HTTP_STATUS_SCOPE =
	/^(?:GET|HEAD|POST|PUT|PATCH|DELETE):(?:[1-5][0-9]{2})$/u;

function isOciDetailKind(value: string): value is ReleaseOciDetailKind {
	return RELEASE_OCI_DETAIL_KINDS.some((kind) => kind === value);
}

export function releaseOciDetailKindOf(
	value: string,
): ReleaseOciDetailKind | undefined {
	return isOciDetailKind(value) ? value : undefined;
}

function isValidOciRequestedScope(
	kind: ReleaseOciDetailKind,
	requestedScope: string,
): boolean {
	switch (kind) {
		case "oci-upload-foreign-host":
			return (
				isSingleLineBounded(requestedScope, 253) &&
				OCI_REGISTRY_HOST.test(requestedScope)
			);
		case "oci-upload-path":
			return requestedScope === OCI_UPLOAD_PATH_SCOPE;
		case "oci-http-status":
			return (
				isSingleLineBounded(requestedScope, 24) &&
				OCI_HTTP_STATUS_SCOPE.test(requestedScope)
			);
		case "oci-blob-size":
			return requestedScope === OCI_BLOB_SIZE_SCOPE;
		case "oci-blob-not-observed":
			return requestedScope === OCI_BLOB_NOT_OBSERVED_SCOPE;
		case "oci-credential-refused":
			return isValidReleaseFreightScope(requestedScope);
		default:
			return false;
	}
}

export function validateOciReasonStructuredDetail(
	detail: ReasonStructuredDetail | undefined,
): ReasonStructuredDetail | undefined {
	if (!detail) return undefined;
	const credentialRef = detail.credentialRef?.trim() ?? "";
	const requestedScope = detail.requestedScope?.trim() ?? "";
	const kind = releaseOciDetailKindOf(detail.detailKind?.trim() ?? "");
	if (
		!kind ||
		!isValidReleaseFreightCredentialRef(credentialRef) ||
		!isValidOciRequestedScope(kind, requestedScope)
	)
		return undefined;
	return create(ReasonStructuredDetailSchema, {
		credentialRef,
		requestedScope,
		detailKind: kind,
	});
}

export function formatOciBlockedDetail(
	code: string,
	detail: ReasonStructuredDetail,
): string {
	const validated = validateOciReasonStructuredDetail(detail);
	if (!validated) return code.trim() || "unknown";
	const base = `${code}: provider=oci-registry oci-reason=${validated.detailKind} credential=${validated.credentialRef}`;
	switch (validated.detailKind) {
		case "oci-upload-foreign-host":
			return `${base} host=${validated.requestedScope}`;
		case "oci-upload-path":
			return `${base} ${validated.detailKind}`;
		case "oci-http-status":
			return `${base} http=${validated.requestedScope}`;
		case "oci-blob-size":
		case "oci-blob-not-observed":
			return `${base} ${validated.detailKind}`;
		case "oci-credential-refused":
			return `${base} scope=${validated.requestedScope}`;
		default:
			return `${base} scope=${validated.requestedScope}`;
	}
}

export function ociStructuredScopePayload(
	reason: ReleaseOciDetailKind,
	scopePayload: string,
	realizeScope: string,
): string {
	switch (reason) {
		case "oci-credential-refused":
			return realizeScope;
		case "oci-upload-path":
			return OCI_UPLOAD_PATH_SCOPE;
		case "oci-blob-size":
			return OCI_BLOB_SIZE_SCOPE;
		case "oci-blob-not-observed":
			return OCI_BLOB_NOT_OBSERVED_SCOPE;
		default:
			return scopePayload.trim();
	}
}
