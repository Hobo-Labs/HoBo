// Bundle the connect page's browser client (React + vercel-labs/ui) and its
// stylesheet (UI SDK's web.css themed with HoBo's tokens) into dist/client/.
// The server serves exactly these two files; nothing is loaded from a CDN.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "client");
mkdirSync(out, { recursive: true });

await build({
	entryPoints: [path.join(root, "src", "client", "main.tsx")],
	outfile: path.join(out, "connect.js"),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	jsx: "automatic",
	minify: true,
	legalComments: "linked",
	define: { "process.env.NODE_ENV": '"production"' },
	logLevel: "warning",
});

await build({
	entryPoints: [path.join(root, "src", "client", "styles.css")],
	outfile: path.join(out, "connect.css"),
	bundle: true,
	minify: true,
	logLevel: "warning",
});
