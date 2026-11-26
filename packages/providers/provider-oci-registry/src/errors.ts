/**
 * Typed refusals of the OCI registry realizer.
 *
 * Every refusal is a core `ResolverError` (`RESOLVER_PROVIDER_REJECTED`).
 * `reason` is a closed vocabulary. `scopePayload` stored on the error is a
 * closed token: a DNS hostname, `METHOD:status`, `registry-basic`,
 * `registry-token`, or one fixed scope word. A Location, query string, upload
 * id, token, or credential is stored as empty. Release logs validate the
 * token again before printing it.
 */
import { ResolverError } from "@hobo/core";
import { isRegistryHost, OCI_REGISTRY_IMAGE_PRODUCT_ID } from "./reference.js";

// public-contract: closed oci registry structured refusal reasons for release logs.
export const OCI_REGISTRY_REFUSAL_REASONS = Object.freeze([
	"oci-upload-foreign-host",
	"oci-upload-path",
	"oci-http-status",
	"oci-blob-size",
	"oci-blob-not-observed",
	"oci-credential-refused",
] as const);

export type OciRegistryRefusalReason =
	(typeof OCI_REGISTRY_REFUSAL_REASONS)[number];

const HTTP_STATUS_SCOPE =
	/^(?:GET|HEAD|POST|PUT|PATCH|DELETE):(?:[1-5][0-9]{2})$/u;

/** Drop anything that is not the closed token for `reason`. */
function closedOciScopePayload(
	reason: OciRegistryRefusalReason,
	scopePayload: string,
): string {
	const scope = scopePayload.trim();
	switch (reason) {
		case "oci-upload-foreign-host":
			return isRegistryHost(scope) ? scope : "";
		case "oci-http-status":
			return HTTP_STATUS_SCOPE.test(scope) ? scope : "";
		case "oci-upload-path":
			return "blob-upload-path";
		case "oci-blob-size":
			return "over-transport-bound";
		case "oci-blob-not-observed":
			return "post-upload";
		case "oci-credential-refused":
			return scope === "registry-basic" || scope === "registry-token"
				? scope
				: "";
	}
}

export class OciRegistryRefusal extends ResolverError {
	readonly reason: OciRegistryRefusalReason;
	readonly scopePayload: string;

	constructor(
		reason: OciRegistryRefusalReason,
		scopePayload: string,
		message: string,
		remediation?: string,
	) {
		super(
			"RESOLVER_PROVIDER_REJECTED",
			remediation ? `${message}. Remediation: ${remediation}` : message,
			OCI_REGISTRY_IMAGE_PRODUCT_ID,
		);
		this.name = "OciRegistryRefusal";
		this.reason = reason;
		this.scopePayload = closedOciScopePayload(reason, scopePayload);
	}
}

export function refuse(
	reason: OciRegistryRefusalReason,
	scopePayload: string,
	message: string,
	remediation?: string,
): never {
	throw new OciRegistryRefusal(reason, scopePayload, message, remediation);
}
