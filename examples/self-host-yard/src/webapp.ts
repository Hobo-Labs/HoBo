/**
 * The status-page web app: a plain fetch handler serving a tiny HTML shell
 * that names the components the bound API reports on. Bound to the API via
 * `.dependsOn(api)` in `src/bindle.ts`.
 */
export function statusWeb(_request: Request): Response {
	return new Response(
		`<!doctype html>
<title>self-host-yard status</title>
<h1>self-host-yard</h1>
<p>Status of the self-hosted Yard, served by its own status page:</p>
<ul>
  <li>yard-control-plane</li>
  <li>event-store</li>
  <li>status-api</li>
</ul>
<p>Data: <code>GET /status</code> on the bound API.</p>
`,
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}
