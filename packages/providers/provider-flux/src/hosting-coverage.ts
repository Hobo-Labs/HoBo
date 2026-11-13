import type { ResolverError } from "@hobo/core";
import { FLUX_APP_PRODUCT_ID } from "./app-resolver.js";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import {
	FLUX_TRAFFIC_ROUTING_ABSENT,
	FLUX_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

/** Every Flux hosting product with a shipped resolver (I14). */
export const FLUX_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze([
	FLUX_APP_PRODUCT_ID,
]);

/** Flux hosting surfaces no resolver realizes. Each is a decision. */
export const FLUX_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: "flux.orbit-git/v1",
			reason:
				"Orbit deploys by building a Git branch on the node, so the running bits are rebuilt rather than promoted (I1), and production Flux apply requires an OCI digest.",
			remediation:
				"Build the image in CI, publish it by digest, and deliver it through flux.app/v1 with digest-pinned compose images.",
		}),
	]);

/** The I14 coverage document for Flux. */
export const FLUX_HOSTING_COVERAGE: HostingCoverage = defineHostingCoverage({
	providerId: "flux",
	resolvedProductIds: FLUX_RESOLVED_PRODUCT_IDS,
	unresolved: FLUX_UNRESOLVED_PRODUCTS,
	profile: FLUX_TRAFFIC_ROUTING_PROFILE,
	absent: FLUX_TRAFFIC_ROUTING_ABSENT,
});

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product Flux does not realize. */
export function fluxProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(FLUX_HOSTING_COVERAGE, productId);
}
