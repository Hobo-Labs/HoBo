import { honoEntrypoint } from "@hobo/adapter-hono";
import { bindle, env } from "@hobo/bindles";

import { app as api } from "./api.js";
import { app as web } from "./webapp.js";

const campEnv = env({ GREETING_PREFIX: "howdy", APP_TITLE: "howdy" });

export default bindle("hello-bindle", (builder) => {
	const apiService = builder.api(honoEntrypoint(api)).with(campEnv);
	const webService = builder
		.web(honoEntrypoint(web))
		.with(campEnv)
		.dependsOn(apiService);
	return { api: apiService, web: webService };
});
