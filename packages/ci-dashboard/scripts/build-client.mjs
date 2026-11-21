// Bundle the dashboard's browser client into dist/client/app.js. The relay
// serves exactly this file beside the page; nothing is loaded from a CDN.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "client");
mkdirSync(out, { recursive: true });

// zod/mini re-exports every message locale as a namespace, which no bundler
// can drop. The client reads no zod message text, so the locales are left out.
const noZodLocales = {
	name: "no-zod-locales",
	setup(builder) {
		builder.onResolve({ filter: /\/locales\/index\.js$/ }, (args) =>
			args.importer.includes(`${path.sep}zod${path.sep}`)
				? { path: "zod-locales", namespace: "empty" }
				: undefined,
		);
		builder.onLoad({ filter: /.*/, namespace: "empty" }, () => ({
			contents: "export {};",
			loader: "js",
		}));
	},
};

const browserUtil = {
	name: "browser-node-util",
	setup(builder) {
		builder.onResolve({ filter: /^node:util$/ }, () => ({
			path: "node-util",
			namespace: "browser-util",
		}));
		builder.onLoad({ filter: /.*/, namespace: "browser-util" }, () => ({
			contents:
				"const VT = /[\\u001b\\u009b][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))/g;\nexport function stripVTControlCharacters(text) { return String(text).replace(VT, \"\"); }\n",
			loader: "js",
		}));
	},
};

await build({
	entryPoints: [path.join(root, "src", "client.ts")],
	outfile: path.join(out, "app.js"),
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	minify: true,
	legalComments: "none",
	logLevel: "warning",
	plugins: [noZodLocales, browserUtil],
});
