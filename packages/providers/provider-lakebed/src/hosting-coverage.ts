import type { ResolverError } from "@hobo/core";
import { LAKEBED_CAPSULE_PRODUCT_ID } from "./capsule-resolver.js";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import {
	LAKEBED_TRAFFIC_ROUTING_ABSENT,
	LAKEBED_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

export const LAKEBED_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze([
	LAKEBED_CAPSULE_PRODUCT_ID,
]);

const INSIDE_CAPSULE =
	"declare it in desired.resources of the lakebed.capsule/v1 deployment that uses it";

export const LAKEBED_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: "lakebed.capsule-kv/v1",
			reason:
				"Capsule KV is provisioned by the capsule deploy program that binds it; Lakebed has no standalone KV API.",
			remediation: INSIDE_CAPSULE,
		}),
		Object.freeze({
			productId: "lakebed.file-store/v1",
			reason:
				"The File Store is provisioned by the capsule deploy program that binds it; Lakebed has no standalone storage API.",
			remediation: INSIDE_CAPSULE,
		}),
		Object.freeze({
			productId: "lakebed.reactive-db/v1",
			reason:
				"The Reactive DB is provisioned by the capsule deploy program that binds it; Lakebed has no standalone database API.",
			remediation: INSIDE_CAPSULE,
		}),
		Object.freeze({
			productId: "lakebed.traffic-route/v1",
			reason:
				"Traffic changes have one mutator: Station cutover (D8). A route binding is a TrafficRoutingPort realization, not a delivered resource.",
			remediation:
				"Let Station cutover apply the routing plan; the Lakebed adapter emits the lakebed:traffic-route driver resource through realizeTrafficRoutingPlan.",
		}),
	]);

export const LAKEBED_HOSTING_COVERAGE: HostingCoverage = defineHostingCoverage({
	providerId: "lakebed",
	resolvedProductIds: LAKEBED_RESOLVED_PRODUCT_IDS,
	unresolved: LAKEBED_UNRESOLVED_PRODUCTS,
	profile: LAKEBED_TRAFFIC_ROUTING_PROFILE,
	absent: LAKEBED_TRAFFIC_ROUTING_ABSENT,
});

export function lakebedProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(LAKEBED_HOSTING_COVERAGE, productId);
}
