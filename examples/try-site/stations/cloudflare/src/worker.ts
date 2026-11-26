/**
 * Anonymous Cloudflare Environment Station worker — operator bootstrap only.
 * No Bindle / app code. Serves station health for Pool → Deploy stations.
 * Canonical module also ships in @hobo/provider-cloudflare (ENVIRONMENT_STATION_WORKER_MODULE).
 */
export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const body = {
			ok: true,
			kind: "hobo-environment-station",
			provider: "cloudflare",
			anonymous: true,
			temporary: true,
		};
		if (url.pathname === "/health" || url.pathname === "/") {
			return Response.json(body);
		}
		return new Response(
			`<!doctype html><html><body data-hobo-station="cloudflare" data-anonymous="true"><h1>HoBo Environment Station</h1><pre>${JSON.stringify(body, null, 2)}</pre></body></html>`,
			{ headers: { "content-type": "text/html; charset=utf-8" } },
		);
	},
};
