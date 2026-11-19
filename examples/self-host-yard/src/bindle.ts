import { bindle } from "@hobo/bindles";

import { statusApi } from "./api.js";
import { statusWeb } from "./webapp.js";

export default bindle("self-host-yard", (b) => {
	const api = b.api(() => statusApi);
	const web = b.web(() => statusWeb).dependsOn(api);
	return { api, web };
});
