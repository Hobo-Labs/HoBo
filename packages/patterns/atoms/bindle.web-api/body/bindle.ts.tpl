import { honoEntrypoint } from "@hobo/adapter-hono";
import { bindle } from "@hobo/bindles";

import { app as api } from "./api.js";
import { campEnv } from "./camp-env.js";
import { app as web } from "./webapp.js";

export default bindle("{{name}}", (b) => {
	const a = b.api(honoEntrypoint(api)).with(campEnv);
	const w = b.web(honoEntrypoint(web)).with(campEnv).dependsOn(a);
	return { api: a, web: w };
});
