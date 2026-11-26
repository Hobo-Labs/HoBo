import type { ResolverError } from "@hobo/core";
import {
	defineHostingCoverage,
	type HostingCoverage,
	hostingProductRefusal,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
import { BROWSER_WASM_GUEST_PRODUCT_ID } from "./guest-resolver.js";
import {
	BROWSER_WASM_TRAFFIC_ROUTING_ABSENT,
	BROWSER_WASM_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

/** Every Browser WASM hosting product with a shipped resolver (I14). */
export const BROWSER_WASM_RESOLVED_PRODUCT_IDS: readonly string[] =
	Object.freeze([BROWSER_WASM_GUEST_PRODUCT_ID]);

const IN_BROWSER =
	"publish it as a guest (port kv or queue in the guest manifest) through browser-wasm.guest/v1, or bind a hosted provider (for example @hobo/provider-upstash or @hobo/provider-kafka) for a delivered store";

/** Equivalence classes no resolver delivers on their own. Each is a decision. */
export const BROWSER_WASM_UNRESOLVED_PRODUCTS: readonly UnresolvedHostingProduct[] =
	Object.freeze([
		Object.freeze({
			productId: "browser-wasm.kv/v1",
			reason:
				"In-browser KV lives in each visitor's browsing context and is created by the guest runtime there; no server-side resource exists to reconcile.",
			remediation: IN_BROWSER,
		}),
		Object.freeze({
			productId: "browser-wasm.queue/v1",
			reason:
				"The in-browser queue lives in each visitor's browsing context and is created by the guest runtime there; no server-side resource exists to reconcile.",
			remediation: IN_BROWSER,
		}),
	]);

/** The I14 coverage document for Browser WASM. */
export const BROWSER_WASM_HOSTING_COVERAGE: HostingCoverage =
	defineHostingCoverage({
		providerId: "browser-wasm",
		resolvedProductIds: BROWSER_WASM_RESOLVED_PRODUCT_IDS,
		unresolved: BROWSER_WASM_UNRESOLVED_PRODUCTS,
		profile: BROWSER_WASM_TRAFFIC_ROUTING_PROFILE,
		absent: BROWSER_WASM_TRAFFIC_ROUTING_ABSENT,
	});

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product Browser WASM does not realize. */
export function browserWasmProductRefusal(
	productId: string,
): ResolverError | undefined {
	return hostingProductRefusal(BROWSER_WASM_HOSTING_COVERAGE, productId);
}
