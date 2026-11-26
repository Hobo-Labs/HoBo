import { bindle } from "@hobo/bindles";

import { shopApi } from "./api.js";
import { storefront } from "./webapp.js";

/**
 * The bindle config does the wiring:
 *  - `b.kv()` / `b.queue()` declare the backing resources (product catalog,
 *    order intake) with least-privilege `allow` verbs,
 *  - `b.api(...)` accepts and binds the shop API handler and depends on both
 *    backing resources,
 *  - `b.web(...)` defines the storefront and `.dependsOn(api)` binds it to
 *    the API.
 *
 * The bindle is provider-agnostic and STAYS provider-agnostic: provider
 * selection is forbidden on a Bindle (`bindle-provider-selection-forbidden`)
 * and belongs on a Yard — attach this same definition to a provider-specific
 * Camp/Yard (e.g. `camp("prod", { defaultProvider: providerSelection("aws") })`)
 * per target cloud without changing a single bindle byte.
 */
export default bindle("multi-cloud-shop", (b) => {
	const products = b.kv().allow("get", "set");
	const orders = b.queue().allow("enqueue");
	const api = b.api(() => shopApi).dependsOn(products, orders);
	const web = b.web(() => storefront).dependsOn(api);
	return { products, orders, api, web };
});
