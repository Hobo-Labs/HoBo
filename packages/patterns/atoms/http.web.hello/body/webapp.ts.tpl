import { Hono } from "hono";

export const app = new Hono().get("/", async (c) => {
	const name = c.req.query("name") ?? "";
	const title = process.env.APP_TITLE?.trim() || "{{name}}";
	const apiBase = process.env.services__api__http__0;
	if (!apiBase) {
		return c.html(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${esc(title)}</title></head>
  <body>
    <h1 data-testid="app-title">${esc(title)}</h1>
    <p data-testid="greeting">hello, world</p>
  </body>
</html>`);
	}
	const url = new URL(
		name ? `hello?name=${encodeURIComponent(name)}` : "hello",
		apiBase.endsWith("/") ? apiBase : `${apiBase}/`,
	);
	const { message } = (await (await fetch(url)).json()) as { message: string };
	return c.html(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${esc(title)}</title></head>
  <body>
    <h1 data-testid="app-title">${esc(title)}</h1>
    <p data-testid="greeting">${esc(message)}</p>
  </body>
</html>`);
});

function esc(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
