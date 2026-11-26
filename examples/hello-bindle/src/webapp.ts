import { Hono } from "hono";

/** Public web — calls private api via camp-injected services__api__http__0. */
export const app = new Hono().get("/", async (c) => {
	const name = c.req.query("name") ?? "";
	const title = process.env.APP_TITLE?.trim() || "hello-bindle";
	const apiBase = process.env.services__api__http__0;
	if (!apiBase) {
		throw new Error("services__api__http__0 missing — camp must inject discovery");
	}
	const url = new URL(
		name ? `hello?name=${encodeURIComponent(name)}` : "hello",
		apiBase.endsWith("/") ? apiBase : `${apiBase}/`,
	);
	// SAFETY: assertion to `it (await fetch(url)).json()) as { message: string }; r` is required at this boundary.
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
