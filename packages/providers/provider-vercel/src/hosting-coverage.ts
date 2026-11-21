import type { ResolverError } from "@hobo/core";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import { VERCEL_RESOLVED_PRODUCT_IDS } from "./resolvers.js";
import { VERCEL_EDGE_FUNCTION_PRODUCT_ID } from "./slots.js";
import {
	VERCEL_TRAFFIC_ROUTING_ABSENT,
	VERCEL_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

/** Catalogued Vercel products no resolver realizes. Each is a decision. */
export const VERCEL_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: VERCEL_EDGE_FUNCTION_PRODUCT_ID,
			reason:
				"Vercel functions are produced by a deployment; Vercel documents no endpoint that creates one as a standalone resource.",
			remediation:
				"Deliver the functions with the project's deployment (vercel.project/v1), or use a provider whose functions are standalone resources (cloudflare workers, aws lambda).",
		}),
	]);

/** The I14 coverage document for Vercel. */
export const VERCEL_HOSTING_COVERAGE: HostingCoverage = defineHostingCoverage({
	providerId: "vercel",
	resolvedProductIds: [...VERCEL_RESOLVED_PRODUCT_IDS],
	unresolved: VERCEL_UNRESOLVED_PRODUCTS,
	profile: VERCEL_TRAFFIC_ROUTING_PROFILE,
	absent: VERCEL_TRAFFIC_ROUTING_ABSENT,
});

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product Vercel does not realize. */
export function vercelProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(VERCEL_HOSTING_COVERAGE, productId);
}
