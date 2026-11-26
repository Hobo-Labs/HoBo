import { ResolverError } from "@hobo/core";
import { OCI_REGISTRY_IMAGE_PRODUCT_ID } from "./reference.js";

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
		this.scopePayload = scopePayload;
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
