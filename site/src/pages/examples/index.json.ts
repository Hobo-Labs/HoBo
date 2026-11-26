import type { APIRoute } from "astro";

import { loadExamplesCatalog } from "../../lib/examples/catalog.js";

export const prerender = true;

export const GET: APIRoute = async () =>
	new Response(JSON.stringify(await loadExamplesCatalog()), {
		headers: { "content-type": "application/json; charset=utf-8" },
	});
