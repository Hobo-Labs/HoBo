import { honoEntrypoint } from "@hobo/adapter-hono";
import { bindle, env } from "@hobo/bindles";

import { app as api } from "./api.js";
import { app as web } from "./webapp.js";

const campEnv = env({ GREETING_PREFIX: "howdy", APP_TITLE: "howdy" });

export default bindle("hello-bindle", (b) => {
	const a = b.api(honoEntrypoint(api)).with(campEnv);
	const w = b.web(honoEntrypoint(web)).with(campEnv).dependsOn(a);
	return { api: a, web: w };
});
