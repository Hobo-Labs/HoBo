import type { ResolverError } from "@hobo/core";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import {
	OCI_REGISTRY_IMAGE_PRODUCT_ID,
	OCI_REGISTRY_PROVIDER_ID,
} from "./reference.js";
import {
	OCI_REGISTRY_TRAFFIC_ROUTING_ABSENT,
	OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

/** Every OCI registry product with a shipped resolver (I14). */
export const OCI_REGISTRY_RESOLVED_PRODUCT_IDS: readonly string[] =
	Object.freeze([OCI_REGISTRY_IMAGE_PRODUCT_ID]);

/** Registry surfaces this package catalogs and refuses, each a decision. */
export const OCI_REGISTRY_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: "oci-registry.repository/v1",
			reason:
				"The distribution spec has no repository create or delete; ECR, Artifact Registry and Docker Hub create repositories through their own control-plane APIs, and GHCR, Harbor and Zot create them on first push.",
			remediation:
				"Create the repository with the registry's own provider package (for example the AWS or GCP resolvers) or let first push create it; deliver images into it through oci-registry.image/v1.",
		}),
		Object.freeze({
			productId: "oci-registry.retention-policy/v1",
			reason:
				"Retention, immutability and garbage collection are registry-specific settings with no distribution-spec surface.",
			remediation:
				"Set them with the registry's own tooling or provider package; HoBo deletes only the tags it declared and, under allowManifestDelete, the manifest by digest.",
		}),
	]);

/** The I14 coverage document for the OCI registry realizer. */
export const OCI_REGISTRY_HOSTING_COVERAGE: HostingCoverage =
	defineHostingCoverage({
		providerId: OCI_REGISTRY_PROVIDER_ID,
		resolvedProductIds: OCI_REGISTRY_RESOLVED_PRODUCT_IDS,
		unresolved: OCI_REGISTRY_UNRESOLVED_PRODUCTS,
		profile: OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE,
		absent: OCI_REGISTRY_TRAFFIC_ROUTING_ABSENT,
	});

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product this package does not realize. */
export function ociRegistryProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(OCI_REGISTRY_HOSTING_COVERAGE, productId);
}
