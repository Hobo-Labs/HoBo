/**
 * The module Cloudflare runs (`main_module`). workerd accepts only handlers
 * and Durable Object classes as a main module's exports, so this exports the
 * fetch handler and `ConfigStore`, nothing else.
 */
import {
	type ConfigServiceEnv,
	createConfigServiceHandler,
} from "./handler.js";

export { ConfigStore } from "./store.js";

const handler = createConfigServiceHandler((input, init) => fetch(input, init));

export default {
	fetch(request: Request, env: ConfigServiceEnv): Promise<Response> {
		return handler.fetch(request, env);
	},
};
