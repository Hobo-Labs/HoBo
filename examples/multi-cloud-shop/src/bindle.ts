import { bindle } from "@hobo/bindles";

import { shopApi } from "./api.js";
import { storefront } from "./webapp.js";

export default bindle("multi-cloud-shop", (b) => {
	const products = b.kv().allow("get", "set");
	const orders = b.queue().allow("enqueue");
	const api = b.api(() => shopApi).dependsOn(products, orders);
	const web = b.web(() => storefront).dependsOn(api);
	return { products, orders, api, web };
});
