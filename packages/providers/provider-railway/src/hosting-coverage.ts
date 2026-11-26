import type { ResolverError } from "@hobo/core";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import {
	RAILWAY_TRAFFIC_ROUTING_ABSENT,
	RAILWAY_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

// public-contract: Railway's authenticated service product (mirrors resolvers.ts).
const SERVICE_PRODUCT_ID = "railway.service/v1";

/** Every Railway hosting product with a shipped resolver (I14). */
export const RAILWAY_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze([
	SERVICE_PRODUCT_ID,
]);

/**
 * Railway products the equivalence table names but no resolver realizes.
 * Each is a decision, not a backlog item.
 */
export const RAILWAY_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: "railway.queue/v1",
			reason:
				"Railway sells no first-party queue; a queue on Railway is a container the tenant deploys as an ordinary service.",
			remediation:
				"Deploy the broker as an approved existing Railway service and deliver it through railway.service/v1, or bind a queue provider such as @hobo/provider-kafka or @hobo/provider-upstash.",
		}),
		Object.freeze({
			productId: "railway.redis/v1",
			reason:
				"Railway databases are template-deployed services with no documented convergent create; a template deploy returns a new service per call.",
			remediation:
				"Create the Redis service once in the Railway project, then adopt it as an approved existing service through railway.service/v1, or bind @hobo/provider-upstash for a managed key-value store.",
		}),
	]);

/** The I14 coverage document for Railway. */
export const RAILWAY_HOSTING_COVERAGE: HostingCoverage = defineHostingCoverage({
	providerId: "railway",
	resolvedProductIds: RAILWAY_RESOLVED_PRODUCT_IDS,
	unresolved: RAILWAY_UNRESOLVED_PRODUCTS,
	profile: RAILWAY_TRAFFIC_ROUTING_PROFILE,
	absent: RAILWAY_TRAFFIC_ROUTING_ABSENT,
});

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product Railway does not realize. */
export function railwayProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(RAILWAY_HOSTING_COVERAGE, productId);
}
