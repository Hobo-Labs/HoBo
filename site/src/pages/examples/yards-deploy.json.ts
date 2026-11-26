import type { APIRoute } from "astro";

import { loadYardDeploySources } from "../../lib/examples/yard-deploy-source.js";

export const prerender = true;

export const GET: APIRoute = async () =>
	new Response(JSON.stringify(await loadYardDeploySources()), {
		headers: { "content-type": "application/json; charset=utf-8" },
	});
