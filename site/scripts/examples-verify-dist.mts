/**
 * Examples verification against the BUILT site — the deploy gate that was
 * missing.
 *
 * Every prior Examples check drove `astro dev`, whose Vite plugin serves the
 * same-origin temporary-station APIs — so "green locally" said nothing about
 * GitHub Pages, where none of those APIs exist. This script serves `dist/`
 * over plain static HTTP (exactly what Pages does) and walks the real visitor
 * flow:
 *
 *   1. catalog: /HoBo/examples/index.json parses and carries real Bindle source
 *   2. runtime: /HoBo/examples/runtime/manifest.json is present (the ~25MB WIT
 *      bundle ships — without it the two browser-wit apps are inert)
 *   3. pool: "Deploy stations" provisions the in-page browser-wasm station;
 *      remote yards fail per-target with remediation, never aborting the pool
 *   4. ship: hello-world loads onto the station and the WIT component answers
 *      (the station posts "ready" only after a real invoke round-trip)
 *
 * Usage:
 *   node --import tsx scripts/examples-verify-dist.mts [--dist dist] [--port 0]
 *
 * Exit code 0 = the deployed artifact works; non-zero = do not publish.
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
	args.set(process.argv[i], process.argv[i + 1] ?? "");

const DIST = resolve(args.get("--dist") ?? "dist");
const PORT = Number(args.get("--port") ?? 0);
const STRIPPED = process.env.HOBO_PAGES_STRIP_WIT === "1";

interface MimeByExt {
	readonly [ext: string]: string;
}
const TYPES: MimeByExt = {
	".html": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".json": "application/json",
	".wasm": "application/wasm",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".txt": "text/plain",
	".md": "text/markdown",
};

function serve(dist: string, port: number): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
		let path = url.startsWith("/HoBo") ? url.slice("/HoBo".length) : url;
		if (path === "" || path.endsWith("/")) path += "index.html";
		let file = join(dist, path);
		if (!existsSync(file) && existsSync(join(dist, path, "index.html")))
			file = join(dist, path, "index.html");
		if (!existsSync(file)) {
			res.writeHead(404, { "content-type": "text/html" });
			res.end(
				existsSync(join(dist, "404.html"))
					? readFileSync(join(dist, "404.html"))
					: "not found",
			);
			return;
		}
		res.writeHead(200, {
			"content-type": TYPES[extname(file)] ?? "application/octet-stream",
		});
		res.end(readFileSync(file));
	});
	return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

if (!existsSync(DIST)) {
	console.error(`dist not found at ${DIST} — run the site build first`);
	process.exit(1);
}

const server = await serve(DIST, PORT);
// SAFETY: assertion required at this I/O boundary.
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// 1. Catalog is real: entries carry actual Bindle source + runtime descriptors.
const catalogRes = await fetch(`${origin}/HoBo/examples/index.json`);
check("catalog: /HoBo/examples/index.json responds", catalogRes.ok);
// SAFETY: assertion required at this I/O boundary.
const catalog = (await catalogRes.json()) as readonly {
	id: string;
	source: string;
	deployKind: string;
}[];
check("catalog: has entries", catalog.length >= 4, `${catalog.length} apps`);
check(
	"catalog: hello-world ships real Bindle source",
	catalog.some(
		(entry) => entry.id === "hello-world" && entry.source.includes("@hobo/bindles"),
	),
);

// 2. The browser WIT runtime ships with the artifact (unless deliberately
// stripped, in which case in-page examples are known-inert and we say so).
const manifestRes = await fetch(`${origin}/HoBo/examples/runtime/manifest.json`);
if (STRIPPED) {
	console.log("· runtime: HOBO_PAGES_STRIP_WIT=1 — skipping runtime + browser flow");
} else {
	check("runtime: manifest.json ships", manifestRes.ok);
	if (manifestRes.ok) {
		// SAFETY: assertion required at this I/O boundary.
		const manifest = (await manifestRes.json()) as {
			assets: readonly string[];
			assetDigests: Record<string, string>;
		};
		for (const asset of manifest.assets) {
			const res = await fetch(`${origin}/HoBo/examples/runtime/${asset}`, {
				method: "HEAD",
			});
			if (!res.ok) check(`runtime: asset ${asset} ships`, false, `HTTP ${res.status}`);
		}
		check("runtime: all manifest assets ship", failures.length === 0);
	}

	// 3+4. Real visitor flow in a real browser against the static artifact.
	let browser: Browser | null = null;
	try {
		// PLAYWRIGHT_CHROMIUM_PATH covers hosts whose installed browser revision
		// does not match this playwright version (e.g. /opt/pw-browsers/chromium).
		const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
		browser = await chromium.launch(
			executablePath ? { executablePath } : {},
		);
		const page = await browser.newPage();
		page.setDefaultTimeout(180_000);
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await page.goto(`${origin}/HoBo/examples/`, { waitUntil: "networkidle" });

		const deployStations = page.locator("[data-deploy-stations]");
		await deployStations.waitFor({ state: "visible" });
		await page.waitForFunction(
			() =>
				!document.querySelector<HTMLButtonElement>("[data-deploy-stations]")
					?.disabled,
		);
		await deployStations.click();
		// Remote yards fail per-target on a static host; the pool must still
		// come up with the in-page browser-wasm station.
		await page.waitForFunction(() => {
			const state = document.querySelector("[data-deploy-state]")?.textContent;
			return state === "stations-ready" || state === "failed";
		});
		const poolState = await page
			.locator("[data-deploy-state]")
			.textContent();
		const terminal = (await page.locator("[data-terminal]").textContent()) ?? "";
		check(
			"pool: stations provision on a static host",
			poolState === "stations-ready",
			terminal.split("\n").slice(-3).join(" · "),
		);
		check(
			"pool: browser-wasm station hosts in-page",
			terminal.includes("in-page browser Environment Station") ||
				terminal.includes("local station ready"),
		);

		const deployApps = page.locator("[data-deploy-apps]");
		await page.waitForFunction(
			() =>
				!document.querySelector<HTMLButtonElement>("[data-deploy-apps]")?.disabled,
		);
		await deployApps.click();
		await page.waitForFunction(() => {
			const state = document.querySelector("[data-deploy-state]")?.textContent;
			return state === "live" || state === "failed";
		});
		const shipState = await page.locator("[data-deploy-state]").textContent();
		const shipTerminal =
			(await page.locator("[data-terminal]").textContent()) ?? "";
		// "live" requires the station's postMessage "ready", which fires only
		// after the WIT component answered a real invoke — this is the proof.
		check(
			"ship: hello-world WIT component live on the static artifact",
			shipState === "live",
			shipTerminal.split("\n").slice(-3).join(" · "),
		);
		check(
			"page: no uncaught errors",
			pageErrors.length === 0,
			pageErrors.slice(0, 3).join(" · "),
		);
	} finally {
		await browser?.close();
	}
}

server.close();
if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed — do not publish this dist.`);
	process.exit(1);
}
// SAFETY: assertion required at this I/O boundary.
console.log("\ndist verified: the Examples console works as deployed.");
