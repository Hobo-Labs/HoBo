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
