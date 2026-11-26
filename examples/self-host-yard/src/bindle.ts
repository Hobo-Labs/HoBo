import { bindle } from "@hobo/bindles";

import { statusApi } from "./api.js";
import { statusWeb } from "./webapp.js";

/**
 * The bindle config does the wiring:
 *  - `b.api(...)` accepts and binds the status-page API handler,
 *  - `b.web(...)` defines the status page and `.dependsOn(api)` binds it to
 *    the API.
 *
 * The bindle is deliberately compute-only (api + web). HONEST NARROWING: a
 * kv-backed incident log would be the natural next resource, but data
 * resources compiled through the TS-source loader lower to the generic
 * `hobo:data` port, which no provider in the default self-hosted registry
 * advertises — `hobo plan` would reject the deployment. The two component
 * resources lower to the `compute` port the registry satisfies, so the whole
 * plan/up/down lane runs green against the operator's own Yard.
 */
export default bindle("self-host-yard", (b) => {
	const api = b.api(() => statusApi);
	const web = b.web(() => statusWeb).dependsOn(api);
	return { api, web };
});
