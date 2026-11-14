import type { ResolverError } from "@hobo/core";
import { CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID } from "./cloud-deployment-resolver.js";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import {
	CONVEX_TRAFFIC_ROUTING_ABSENT,
	CONVEX_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

/** Every Convex hosting product with a shipped resolver (I14). */
export const CONVEX_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze([
	CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
]);

/**
 * Convex hosting forms and surfaces no resolver realizes. Each is a decision
 * (see `hosting-forms.ts` for the forms themselves).
 */
export const CONVEX_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: "convex.functions/v1",
			reason:
				"Function code is pushed with a deploy key by `npx convex deploy`; Convex documents no HTTP push, and HoBo has no shell-script escape hatch (R2).",
			remediation:
				"Push code through a RUNBOOK hook run by the existing RunbookExecutor with a broker-minted deploy key, or register a signed hobo:resolver WASM component that calls an agent-local bridge (D6, R2); the deployment itself is delivered through convex.cloud-deployment/v1.",
		}),
		Object.freeze({
			productId: "convex.local-accountless/v1",
			reason:
				"The local accountless backend lives and dies with `npx convex dev` and has no production durability; a tunnel changes reachability, not durability.",
			remediation:
				"Deliver to a Convex Cloud deployment (convex.cloud-deployment/v1) or to the self-hosted OCI form on a container host.",
		}),
		Object.freeze({
			productId: "convex.selfhosted-oci/v1",
			reason:
				"A self-hosted Convex backend is a container on another provider; its realization belongs to that provider's resolver, not to Convex.",
			remediation:
				"Deliver the pinned CONVEX_BACKEND_IMAGE_INDEX_DIGEST image through the container host's resolver (for example railway.service/v1 or a Kubernetes Deployment) with a persistent volume.",
		}),
	]);

/** The I14 coverage document for Convex. */
export const CONVEX_HOSTING_COVERAGE: HostingCoverage = defineHostingCoverage({
	providerId: "convex",
	resolvedProductIds: CONVEX_RESOLVED_PRODUCT_IDS,
	unresolved: CONVEX_UNRESOLVED_PRODUCTS,
	profile: CONVEX_TRAFFIC_ROUTING_PROFILE,
	absent: CONVEX_TRAFFIC_ROUTING_ABSENT,
});

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product Convex does not realize. */
export function convexProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(CONVEX_HOSTING_COVERAGE, productId);
}
