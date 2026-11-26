// Default Cloudflare Worker module for createCloudflareDeployProvider.
//
// Mirrors the barebones hello-bindle API contract (examples/hello-bindle/src/api.ts):
//   GET /            -> web page (HTML).
//   GET /hello?name= -> { "message": "hello, <name>" }, same parse default ("world").
//
// Platform entry file (no build step) — lives under packages/hobo/fixtures, not examples.

const PAGE = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>hello-bindle</title>
		<style>
			body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
			code { background: #f2f2f2; padding: 0.1rem 0.35rem; border-radius: 4px; }
			#out { margin-top: 1rem; font-weight: 600; min-height: 1.2rem; }
			input, button { font-size: 1rem; padding: 0.4rem 0.6rem; }
		</style>
	</head>
	<body>
		<h1>hello-bindle</h1>
		<p>This web app is bound to the API. Ask it for a greeting at <code>/hello</code>.</p>
		<p>
			<input id="name" placeholder="your name" />
			<button onclick="greet()">greet</button>
		</p>
		<div id="out"></div>
		<p style="margin-top:2rem;color:#888;font-size:0.85rem">Deployed by HoBo — the app's provider-agnostic bindle, realized on Cloudflare Workers.</p>
		<script>
			async function greet() {
				const name = document.getElementById('name').value;
				const r = await fetch('/hello' + (name ? ('?name=' + encodeURIComponent(name)) : ''));
				const j = await r.json();
				document.getElementById('out').textContent = j.message;
			}
		</script>
	</body>
</html>`;

// Parse boundary: raw `?name` query -> greeting name, default "world".
function parseGreetingName(rawName) {
	const name = (rawName ?? "").trim();
	return name.length > 0 ? name : "world";
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/hello") {
			const name = parseGreetingName(url.searchParams.get("name"));
			return new Response(JSON.stringify({ message: `hello, ${name}` }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/") {
			return new Response(PAGE, {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		return new Response("not found", { status: 404 });
	},
};
