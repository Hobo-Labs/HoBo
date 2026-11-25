import { honoEntrypoint } from "@hobo/adapter-hono";
import { bindle, env } from "@hobo/bindles";

import { app as api } from "./api.js";
import { app as web } from "./webapp.js";

/** One line: the string the camp injects into api + web (proves apps are live). */
const campEnv = env({ GREETING_PREFIX: "howdy", APP_TITLE: "howdy" });

/** Minimal hello-world: private api + public web, with injectable env. */
export default bindle("hello-bindle", (b) => {
	const a = b.api(honoEntrypoint(api)).with(campEnv);
	const w = b.web(honoEntrypoint(web)).with(campEnv).dependsOn(a);
	return { api: a, web: w };
});
