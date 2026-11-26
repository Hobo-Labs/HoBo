/**
 * Cloudflare Workers entry — serves Wasp OpenSaaS static client.
 * SPA fallback handled by wrangler.toml `not_found_handling`.
 */
export default {
	async fetch(request, env) {
		return env.ASSETS.fetch(request);
	},
};
