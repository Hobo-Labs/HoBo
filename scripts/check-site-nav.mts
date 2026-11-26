/**
 * Assert every site/src/nav.ts docs slug resolves to a page under site/src/pages.
 * Exit 0 on success; print missing paths and exit 1 on failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const navPath = join(root, "site/src/nav.ts");
const pagesRoot = join(root, "site/src/pages");
const nav = readFileSync(navPath, "utf8");
const slugs = [...nav.matchAll(/slug:\s*"(\/[^"]+\/)"/g)].map((m) => m[1]!);

const missing: string[] = [];
for (const slug of slugs) {
	const trimmed = slug.replace(/^\/|\/$/g, "");
	const candidates = [
		join(pagesRoot, `${trimmed}.md`),
		join(pagesRoot, trimmed, "index.md"),
		join(pagesRoot, `${trimmed}.astro`),
		join(pagesRoot, trimmed, "index.astro"),
	];
	if (!candidates.some((c) => existsSync(c))) {
		missing.push(slug);
	}
}

const lines = [
	`nav-file: ${navPath}`,
	`slug-count: ${slugs.length}`,
	`missing-count: ${missing.length}`,
	...missing.map((s) => `missing: ${s}`),
];
console.log(lines.join("\n"));
if (missing.length > 0) {
	process.exit(1);
}
