import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.HOBO_SITE_PORT ?? 4321);
const base = (process.env.HOBO_SITE_BASE ?? "/HoBo/").replace(/\/$/, "") || "";

const mime = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".woff2": "font/woff2",
};

createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		let path = decodeURIComponent(url.pathname);
		if (base && path.startsWith(base)) path = path.slice(base.length) || "/";
		if (path.endsWith("/")) path += "index.html";
		const file = normalize(join(root, path.replace(/^\//, "")));
		if (!file.startsWith(root)) {
			res.writeHead(403);
			res.end("forbidden");
			return;
		}
		const data = await readFile(file);
		const ext = file.slice(file.lastIndexOf("."));
		res.writeHead(200, {
			"content-type": mime[ext] ?? "application/octet-stream",
		});
		res.end(data);
	} catch {
		try {
			const fallback = await readFile(join(root, "404.html"));
			res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
			res.end(fallback);
		} catch {
			res.writeHead(404);
			res.end("not found");
		}
	}
}).listen(port, "0.0.0.0", () => {
	console.log(`hobo-site listening on 0.0.0.0:${port} base=${base || "/"}`);
});
