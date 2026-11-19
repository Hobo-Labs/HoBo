import { createHash } from "node:crypto";
import { ResolverError } from "@hobo/core";

// public-contract: the OCI image (or index) product this package realizes.
export const OCI_REGISTRY_IMAGE_PRODUCT_ID = "oci-registry.image/v1";
// public-contract: provider id stamped on every resolver of this package.
export const OCI_REGISTRY_PROVIDER_ID = "oci-registry";

const REPOSITORY_PATTERN =
	/^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/u;
/** distribution-spec `<reference>` tag grammar. */
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const HOST_PATTERN =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

// public-contract: OCI image manifest media type, copied byte for byte.
export const OCI_IMAGE_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
// public-contract: OCI image index media type, copied byte for byte.
export const OCI_IMAGE_INDEX = "application/vnd.oci.image.index.v1+json";
// public-contract: Docker v2 schema 2 manifest media type, copied byte for byte.
export const DOCKER_MANIFEST_V2 =
	"application/vnd.docker.distribution.manifest.v2+json";
// public-contract: Docker manifest list media type, copied byte for byte.
export const DOCKER_MANIFEST_LIST =
	"application/vnd.docker.distribution.manifest.list.v2+json";

export const MANIFEST_MEDIA_TYPES = Object.freeze([
	OCI_IMAGE_MANIFEST,
	OCI_IMAGE_INDEX,
	DOCKER_MANIFEST_V2,
	DOCKER_MANIFEST_LIST,
] as const);
export type ManifestMediaType = (typeof MANIFEST_MEDIA_TYPES)[number];

export const INDEX_MEDIA_TYPES: readonly string[] = Object.freeze([
	OCI_IMAGE_INDEX,
	DOCKER_MANIFEST_LIST,
]);

export const MANIFEST_ACCEPT = MANIFEST_MEDIA_TYPES.join(", ");

export function rejected(message: string, remediation?: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		remediation ? `${message}. Remediation: ${remediation}` : message,
		OCI_REGISTRY_IMAGE_PRODUCT_ID,
	);
}

export function unparseable(message: string): never {
	throw new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		message,
		OCI_REGISTRY_IMAGE_PRODUCT_ID,
	);
}

export function isRepository(value: string): boolean {
	return value.length <= 255 && REPOSITORY_PATTERN.test(value);
}
export function isTag(value: string): boolean {
	return TAG_PATTERN.test(value);
}
export function isDigest(value: string): boolean {
	return DIGEST_PATTERN.test(value);
}
export function isRegistryHost(value: string): boolean {
	return HOST_PATTERN.test(value);
}

export function digestOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function referrersFallbackTag(digest: string): string {
	return digest.replace(":", "-");
}

export function physicalIdOf(
	registry: string,
	repository: string,
	digest: string,
): string {
	return `${registry}/${repository}@${digest}`;
}
