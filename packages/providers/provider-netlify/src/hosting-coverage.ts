import type { ResolverError } from "@hobo/core";
import { NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID } from "./definitions.js";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import { NETLIFY_RESOLVED_PRODUCT_IDS } from "./resolvers.js";
import {
	NETLIFY_TRAFFIC_ROUTING_ABSENT,
	NETLIFY_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

// public-contract: Netlify Functions, catalogued so a request for them is refused by name.
export const NETLIFY_FUNCTIONS_PRODUCT_ID = "netlify.functions/v1";

/** Catalogued Netlify products no resolver realizes. Each is a decision. */
export const NETLIFY_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
			reason:
				"An anonymous site has no account to reconcile against: it is published once and claimed by a human through its claim URL.",
			remediation:
				"Use provisionTemporaryEnvironmentStation for a throwaway site, or deliver netlify.authenticated-site/v1 plus netlify.static-deploy/v1 for a reconciled one.",
		}),
		Object.freeze({
			productId: NETLIFY_FUNCTIONS_PRODUCT_ID,
			reason:
				"Netlify Functions are produced by a deploy; there is no standalone function resource to reconcile.",
			remediation:
				"Ship the functions inside the site's deploy, or use a provider whose functions are standalone resources (cloudflare workers, aws lambda).",
		}),
	]);

/** The I14 coverage document for Netlify. */
export const NETLIFY_HOSTING_COVERAGE: HostingCoverage = defineHostingCoverage({
	providerId: "netlify",
	resolvedProductIds: [...NETLIFY_RESOLVED_PRODUCT_IDS],
	unresolved: NETLIFY_UNRESOLVED_PRODUCTS,
	profile: NETLIFY_TRAFFIC_ROUTING_PROFILE,
	absent: NETLIFY_TRAFFIC_ROUTING_ABSENT,
});

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product Netlify does not realize. */
export function netlifyProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(NETLIFY_HOSTING_COVERAGE, productId);
}
