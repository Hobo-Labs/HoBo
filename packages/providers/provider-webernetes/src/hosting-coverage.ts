import type { ResolverError } from "@hobo/core";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import { WEBERNETES_POD_PRODUCT_ID } from "./pod-resolver.js";
import {
	WEBERNETES_TRAFFIC_ROUTING_ABSENT,
	WEBERNETES_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

/** Every Webernetes hosting product with a shipped resolver (I14). */
export const WEBERNETES_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze(
	[WEBERNETES_POD_PRODUCT_ID],
);

/** Local-yard products no resolver realizes. Each is a decision. */
export const WEBERNETES_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: "webernetes.kv/v1",
			reason:
				"The local key-value store is bound in-process by the local yard runtime; there is no separately delivered resource to reconcile.",
			remediation:
				"Use the local yard's in-process kv binding, or bind a hosted kv provider (for example @hobo/provider-upstash) for a delivered store.",
		}),
		Object.freeze({
			productId: "webernetes.queue/v1",
			reason:
				"The local queue is bound in-process by the local yard runtime; there is no separately delivered resource to reconcile.",
			remediation:
				"Use the local yard's in-process queue binding, or bind a hosted queue provider (for example @hobo/provider-kafka) for a delivered queue.",
		}),
	]);

/** The I14 coverage document for Webernetes. */
export const WEBERNETES_HOSTING_COVERAGE: HostingCoverage =
	defineHostingCoverage({
		providerId: "webernetes",
		resolvedProductIds: WEBERNETES_RESOLVED_PRODUCT_IDS,
		unresolved: WEBERNETES_UNRESOLVED_PRODUCTS,
		profile: WEBERNETES_TRAFFIC_ROUTING_PROFILE,
		absent: WEBERNETES_TRAFFIC_ROUTING_ABSENT,
	});

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product Webernetes does not realize. */
export function webernetesProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(WEBERNETES_HOSTING_COVERAGE, productId);
}
