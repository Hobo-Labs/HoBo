import type { ResolverError } from "@hobo/core";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import { VERCEL_RESOLVED_PRODUCT_IDS } from "./resolvers.js";
import {
	VERCEL_BLOB_PRODUCT_ID,
	VERCEL_EDGE_FUNCTION_PRODUCT_ID,
} from "./slots.js";
import {
	VERCEL_TRAFFIC_ROUTING_ABSENT,
	VERCEL_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

// public-contract: the Marketplace Postgres equivalence class (vercel:neon-postgres).
export const VERCEL_NEON_POSTGRES_PRODUCT_ID = "vercel.neon-postgres/v1";

/** Catalogued Vercel products no resolver realizes. Each is a decision. */
export const VERCEL_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: VERCEL_BLOB_PRODUCT_ID,
			reason:
				"Vercel documents no endpoint that lists Blob stores by name, so reconcile could not find an existing store and would create a second one on every retry; a non-convergent resolver is worse than none.",
			remediation:
				"Create the Blob store once and reference it from the project, or bind an objectStore provider that ships a resolver (aws, gcp, cloudflare or digitalocean).",
		}),
		Object.freeze({
			productId: VERCEL_EDGE_FUNCTION_PRODUCT_ID,
			reason:
				"Vercel functions are produced by a deployment; Vercel documents no endpoint that creates one as a standalone resource.",
			remediation:
				"Deliver the functions with the project's deployment (vercel.project/v1), or use a provider whose functions are standalone resources (cloudflare workers, aws lambda).",
		}),
		Object.freeze({
			productId: VERCEL_NEON_POSTGRES_PRODUCT_ID,
			reason:
				"Vercel Postgres is Neon attached through the Marketplace; Vercel itself has no database resource to reconcile.",
			remediation:
				"Bind @hobo/provider-neon (neon.claimable-postgres/v1) for the database and attach it to the project.",
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
