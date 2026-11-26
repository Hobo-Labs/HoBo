import { honoEntrypoint } from "@hobo/adapter-hono";
import { bindle } from "@hobo/bindles";

import { app as web } from "./webapp.js";

export default bindle("{{name}}", (b) => ({
	web: b.web(honoEntrypoint(web)),
}));
