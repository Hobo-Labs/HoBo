/**
 * OCI distribution grammar: the names this realizer accepts before any byte
 * leaves the process.
 *
 * Every pattern here is the distribution-spec grammar, bounded. A repository,
 * tag or digest that does not parse is refused with a typed resolver error
 * rather than percent-encoded and sent: an encoded `/` or `..` would be decoded
 * by the registry after every local check has passed.
 */
import { createHash } from "node:crypto";
import { ResolverError } from "@hobo/core";

// public-contract: the OCI image (or index) product this package realizes.
export const OCI_REGISTRY_IMAGE_PRODUCT_ID = "oci-registry.image/v1";
// public-contract: provider id stamped on every resolver of this package.
export const OCI_REGISTRY_PROVIDER_ID = "oci-registry";

/** distribution-spec `<name>` grammar, bounded to 255 characters overall. */
const REPOSITORY_PATTERN =
	/^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/u;
/** distribution-spec `<reference>` tag grammar. */
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
/** Only sha256 is accepted: it is the only algorithm every target registry verifies. */
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
/** A bare DNS host, lowercase, no port, no userinfo, no path. */
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

/** The Accept header every manifest read sends, so no registry down-converts. */
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

/** The digest of exact bytes, in the `sha256:<hex>` form registries report. */
export function digestOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The referrers tag-schema fallback name for a subject digest (OCI 1.1). */
export function referrersFallbackTag(digest: string): string {
	return digest.replace(":", "-");
}

/** Stable physical identity: the coordinates plus the content address. */
export function physicalIdOf(
	registry: string,
	repository: string,
	digest: string,
): string {
	return `${registry}/${repository}@${digest}`;
}
