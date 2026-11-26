const page = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>multi-cloud-shop</title>
	</head>
	<body>
		<h1>multi-cloud-shop</h1>
		<p>This storefront is bound to the shop API. Browse the catalog at <code>/products</code>
		and place an order at <code>POST /orders</code>.</p>
	</body>
</html>
`;

/** The storefront: a plain fetch handler bound to the API (see bindle.ts). */
export function storefront(_request: Request): Response {
	return new Response(page, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}
