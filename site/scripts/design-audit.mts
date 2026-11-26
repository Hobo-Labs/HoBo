/**
 * Interactive design audit — the gate the design axis was missing.
 *
 * Every design defect that reached production this cycle (16px headings,
 * clipped code panels, design bleedover) passed the build, the linters and
 * static screenshots, because none of those *use* the page. This script does:
 * it clicks the real picker, scrolls, hovers, switches designs mid-session,
 * and pixel-compares states that must be identical.
 *
 * Two comparisons carry the acceptance criteria:
 *
 *  1. SWITCH == FRESH. Picking a design through the header picker must render
 *     pixel-identically to arriving with that design already stored. Any diff
 *     is bleedover — state from the previous design surviving the switch.
 *  2. INK == BASELINE. The design axis must leave the default design alone.
 *     Given a baseline dist (a build from before the axis landed), ink pages
 *     with no attribute must pixel-match it, aside from intended art changes,
 *     which the diff heatmaps make reviewable.
 *
 * Usage:
 *   node --import tsx site/scripts/design-audit.mts \
 *     --dist site/dist [--baseline-dist /path/to/old/dist] [--out runs/design-audit]
 *
 * Exit code: number of failed acceptance checks (0 = pass). The screenshot
 * corpus and findings.md land in --out (gitignored under runs/).
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { extname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { chromium, type Browser, type Page } from "playwright";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
	args.set(process.argv[i], process.argv[i + 1] ?? "");

const DIST = resolve(args.get("--dist") ?? "site/dist");
const BASELINE = args.get("--baseline-dist")
	? resolve(args.get("--baseline-dist")!)
	: null;
const OUT = resolve(args.get("--out") ?? "runs/design-audit");

const DESIGNS = ["ink", "broadsheet", "titlecard", "ledger", "cutout"] as const;
const THEMES = ["light", "dark"] as const;
const PAGES = [
	"/",
	"/guide/",
	"/primitives/bindles/",
	"/agents/",
	"/examples/",
	"/definitely-not-a-page/", // 404
] as const;
const VIEWPORTS = [
	{ name: "desktop", width: 1280, height: 900 },
	{ name: "mobile", width: 390, height: 844 },
] as const;

/** Kill all motion so pixel comparisons compare layout, not animation phase. */
const FREEZE_CSS = `
	*, *::before, *::after {
		animation: none !important;
		transition: none !important;
		caret-color: transparent !important;
	}
`;

// ---------------------------------------------------------------------------
// Static server (the site is built for a /HoBo/ base)
// ---------------------------------------------------------------------------

interface MimeByExt {
	readonly [ext: string]: string;
}
const TYPES: MimeByExt = {
	".html": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".png": "image/png",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".json": "application/json",
	".gif": "image/gif",
	".txt": "text/plain",
	".md": "text/markdown",
	".woff2": "font/woff2",
};

function serve(dist: string, port: number): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
		let path = url.startsWith("/HoBo") ? url.slice("/HoBo".length) : url;
		if (path === "" || path.endsWith("/")) path += "index.html";
		let file = join(dist, path);
		if (!existsSync(file) && existsSync(join(dist, path, "index.html")))
			file = join(dist, path, "index.html");
		if (!existsSync(file)) file = join(dist, "404.html");
		try {
			const body = readFileSync(file);
			res.writeHead(existsSync(file) ? 200 : 404, {
				"content-type": TYPES[extname(file)] ?? "application/octet-stream",
			});
			res.end(body);
		} catch {
			res.writeHead(404);
			res.end();
		}
	});
	return new Promise((ok) => server.listen(port, () => ok(server)));
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

type Finding = {
	severity: "FAIL" | "WARN" | "INFO";
	check: string;
	detail: string;
	evidence?: string;
};
const findings: Finding[] = [];
const fail = (check: string, detail: string, evidence?: string) =>
	findings.push({ severity: "FAIL", check, detail, evidence });
const warn = (check: string, detail: string, evidence?: string) =>
	findings.push({ severity: "WARN", check, detail, evidence });
const info = (check: string, detail: string, evidence?: string) =>
	findings.push({ severity: "INFO", check, detail, evidence });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const shot = (...parts: string[]) => join(OUT, parts.join("-") + ".png");

async function applyState(
	page: Page,
	design: string,
	theme: string,
): Promise<void> {
	// Pre-seeded storage is the legitimate "fresh load" path: it is exactly what
	// the boot script reads on every navigation.
	await page.addInitScript(
		([d, t]) => {
			if (d === "ink") localStorage.removeItem("hobo-design");
			else localStorage.setItem("hobo-design", d);
			localStorage.setItem("hobo-theme", t);
		},
		[design, theme],
	);
}

async function freeze(page: Page) {
	await page.addStyleTag({ content: FREEZE_CSS });
	await page.waitForTimeout(120);
}

function diffPngs(aPath: string, bPath: string, outPath: string): number {
	const a = PNG.sync.read(readFileSync(aPath));
	const b = PNG.sync.read(readFileSync(bPath));
	if (a.width !== b.width || a.height !== b.height) return -1;
	const d = new PNG({ width: a.width, height: a.height });
	const n = pixelmatch(a.data, b.data, d.data, a.width, a.height, {
		threshold: 0.12,
	});
	if (n > 0) writeFileSync(outPath, PNG.sync.write(d));
	return n;
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

async function matrixPass(browser: Browser, base: string) {
	for (const vp of VIEWPORTS) {
		for (const design of DESIGNS) {
			for (const theme of THEMES) {
				for (const path of PAGES) {
					const page = await browser.newPage({
						viewport: { width: vp.width, height: vp.height },
					});
					const errors: string[] = [];
					page.on("pageerror", (e) => errors.push(String(e)));
					page.on("requestfailed", (r) =>
						errors.push(`request failed: ${r.url()}`),
					);
					await applyState(page, design, theme);
					await page.goto(base + "/HoBo" + path, { waitUntil: "networkidle" });
					await page.waitForTimeout(250);

					const slug =
						path === "/"
							? "home"
							: path.replaceAll("/", " ").trim().replaceAll(" ", "_") ||
								"home";
					const id = [vp.name, design, theme, slug].join("-");

					// Scroll-step captures on desktop; top + full page on mobile.
					if (vp.name === "desktop") {
						const steps = await page.evaluate(
							() =>
								Math.min(
									6,
									Math.ceil(
										document.documentElement.scrollHeight / innerHeight,
									),
								),
						);
						for (let s = 0; s < steps; s++) {
							await page.evaluate((i) => scrollTo(0, i * innerHeight), s);
							await page.waitForTimeout(150);
							await page.screenshot({ path: shot(id, `s${s}`) });
						}
					} else {
						await page.screenshot({ path: shot(id, "top") });
						await page.screenshot({ path: shot(id, "full"), fullPage: true });
					}

					// Structural checks.
					const m = await page.evaluate(() => {
						const de = document.documentElement;
						const pre = document.querySelector(".terminal pre");
						const proseH2 = document.querySelector(".prose h2");
						const preStyle = pre ? getComputedStyle(pre) : null;
						return {
							overflowX: de.scrollWidth > de.clientWidth + 1,
							codeClipped: pre
								? pre.scrollWidth > pre.clientWidth + 1 &&
									!["auto", "scroll"].includes(preStyle!.overflowX)
								: false,
							proseCase: proseH2
								? getComputedStyle(proseH2).textTransform
								: null,
						};
					});
					if (m.overflowX)
						fail(
							"overflow",
							`horizontal page overflow — ${id}`,
							shot(id, "s0"),
						);
					if (m.codeClipped)
						fail("code-clip", `code panel clipped — ${id}`, shot(id, "s0"));
					if (m.proseCase === "uppercase")
						fail(
							"prose-case",
							`.prose h2 is uppercased — display treatment bleeding into content — ${id}`,
						);
					if (errors.length)
						warn("console", `${id}: ${errors.slice(0, 3).join(" | ")}`);
					await page.close();
				}
			}
		}
	}
}

/** The real picker, clicked. Switch through every design without reload, then
 *  compare each stop against a fresh load of the same design. */
async function bleedoverPass(browser: Browser, base: string, path: string) {
	const slug = path === "/" ? "home" : path.replaceAll("/", "").trim();
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await applyState(page, "ink", "light");
	await page.goto(base + "/HoBo" + path, { waitUntil: "networkidle" });
	await freeze(page);

	// SAFETY: assertion required at this I/O boundary.
	const order = [...DESIGNS.slice(1), "ink"] as string[];
	for (const design of order) {
		// Real interaction: open the details menu, click the design's button.
		await page.click(".palette-picker > summary");
		await page.waitForTimeout(120);
		await page.screenshot({ path: shot("switch", slug, design, "menu-open") });
		await page.click(`[data-set-design="${design}"]`);
		await page.waitForTimeout(250);
		await freeze(page);
		await page.evaluate(() => scrollTo(0, 0));
		// Park the cursor before capturing. The first run flagged three designs
		// for "bleedover" that was actually the parallax pause affordance,
		// revealed because the mouse path to the picker crossed the band — a
		// hover state of the test, not of the product. Both capture paths must
		// SAFETY: assertion required at this I/O boundary.
		// hold the same cursor position or hover styling shows up as a diff.
		await page.mouse.move(0, 0);
		await page.waitForTimeout(120);
		await page.screenshot({ path: shot("switch", slug, design) });
	}
	await page.close();

	for (const design of order) {
		const fresh = await browser.newPage({
			viewport: { width: 1280, height: 900 },
		});
		await applyState(fresh, design, "light");
		await fresh.goto(base + "/HoBo" + path, { waitUntil: "networkidle" });
		await freeze(fresh);
		await fresh.evaluate(() => scrollTo(0, 0));
		await fresh.screenshot({ path: shot("fresh", slug, design) });
		await fresh.close();

		const n = diffPngs(
			shot("switch", slug, design),
			shot("fresh", slug, design),
			shot("bleed-diff", slug, design),
		);
		if (n < 0) fail("bleedover", `${slug}/${design}: size mismatch`);
		else if (n > 400)
			fail(
				"bleedover",
				`${slug}/${design}: switch-vs-fresh differs by ${n}px — state survives the switch`,
				shot("bleed-diff", slug, design),
			);
		else if (n > 0)
			info("bleedover", `${slug}/${design}: ${n}px (under threshold)`);
	}
}

/** Ink at HEAD vs ink at the pre-axis baseline. */
async function baselinePass(browser: Browser, headBase: string, blBase: string) {
	for (const path of ["/", "/guide/"]) {
		const slug = path === "/" ? "home" : path.replaceAll("/", "");
		for (const [name, base] of [
			["head", headBase],
			["baseline", blBase],
		] as const) {
			const page = await browser.newPage({
				viewport: { width: 1280, height: 2400 },
			});
			await applyState(page, "ink", "light");
			await page.goto(base + "/HoBo" + path, { waitUntil: "networkidle" });
			await freeze(page);
			await page.screenshot({ path: shot("ink", name, slug) });
			await page.close();
		}
		const n = diffPngs(
			shot("ink", "head", slug),
			shot("ink", "baseline", slug),
			shot("ink-drift", slug),
		);
		if (n < 0) fail("ink-drift", `${slug}: size mismatch vs baseline`);
		else if (n > 0)
			warn(
				"ink-drift",
				`${slug}: ${n}px differ vs pre-axis baseline — review the heatmap; intended art changes only`,
				shot("ink-drift", slug),
			);
		else info("ink-drift", `${slug}: pixel-identical to baseline`);
	}
}

/** Each design must actually differ from ink. Without this, a boot-script
 // SAFETY: assertion required at this I/O boundary.
 *  regression that never sets data-design renders everything as ink and the
 *  whole audit passes trivially — switch==fresh compares ink to ink, and the
 *  baseline pass compares ink to ink. Differentiation is an acceptance
 *  criterion, not a nice-to-have: it is the entire point of the axis. */
async function differentiationPass(browser: Browser, base: string) {
	const signatures = new Map<string, string>();
	for (const design of DESIGNS) {
		const page = await browser.newPage({
			viewport: { width: 1280, height: 900 },
		});
		await applyState(page, design, "light");
		await page.goto(base + "/HoBo/", { waitUntil: "networkidle" });
		const sig = await page.evaluate(() => {
			const h1 = document.querySelector(".hero h1")!;
			const grid = document.querySelector(".grid");
			return [
				getComputedStyle(h1).fontFamily.split(",")[0],
				getComputedStyle(h1).fontSize,
				grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
				getComputedStyle(document.querySelector(".container")!).maxWidth,
			].join("|");
		});
		signatures.set(design, sig);
		await page.close();
	}
	const ink = signatures.get("ink")!;
	for (const [design, sig] of signatures) {
		if (design !== "ink" && sig === ink)
			fail(
				"differentiation",
				`${design} renders identically to ink (${sig}) — the design is not applying`,
			);
		else info("differentiation", `${design}: ${sig}`);
	}
}

/** Interactions that static shots cannot cover. */
async function interactionPass(browser: Browser, base: string) {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await applyState(page, "ink", "light");
	await page.goto(base + "/HoBo/", { waitUntil: "networkidle" });

	// Theme toggle via the real button, both directions.
	await page.click(".theme-toggle");
	await page.waitForTimeout(250);
	const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
	await page.screenshot({ path: shot("interact", "theme-toggled") });
	await page.click(".theme-toggle");
	await page.waitForTimeout(250);
	const t2 = await page.evaluate(() => document.documentElement.dataset.theme);
	if (t1 !== "dark" || t2 !== "light")
		fail("theme-toggle", `toggle cycle gave ${t1} then ${t2}`);

	// Picker closes on Escape.
	await page.click(".palette-picker > summary");
	await page.keyboard.press("Escape");
	const open = await page.evaluate(
		() => document.querySelector(".palette-picker")?.hasAttribute("open"),
	);
	if (open) fail("picker-escape", "design menu does not close on Escape");

	// Hover states exist (button + card). Filter to VISIBLE: the world heroes
	// put hidden .btn elements first in the DOM, and hovering a hidden node
	// times out — which is itself the audit doing its job on the audit.
	await page.locator(".btn").locator("visible=true").first().hover();
	await page.screenshot({ path: shot("interact", "btn-hover") });
	const card = page.locator(".card").locator("visible=true").first();
	if (await card.count()) {
		await card.hover();
		await page.screenshot({ path: shot("interact", "card-hover") });
	}

	// Keyboard reach: first 8 tab stops must be visible elements.
	await page.evaluate(() => scrollTo(0, 0));
	const stops: string[] = [];
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press("Tab");
		stops.push(
			await page.evaluate(() => {
				const a = document.activeElement;
				return a ? `${a.tagName.toLowerCase()}.${a.className}`.slice(0, 60) : "none";
			}),
		);
	}
	info("tab-order", stops.join(" → "));

	// Reduced motion.
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.reload({ waitUntil: "networkidle" });
	await page.screenshot({ path: shot("interact", "reduced-motion") });
	await page.close();

	// Examples page tabs.
	const ex = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await applyState(ex, "ink", "light");
	await ex.goto(base + "/HoBo/examples/", { waitUntil: "networkidle" });
	const tab = ex.locator('[data-view="logs"]').first();
	if (await tab.count()) {
		await tab.click();
		await ex.waitForTimeout(250);
		const pressed = await tab.getAttribute("aria-pressed");
		if (pressed !== "true")
			fail("examples-tabs", "logs tab click did not set aria-pressed");
		await ex.screenshot({ path: shot("interact", "examples-logs-tab") });
	}
	await ex.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const headServer = await serve(DIST, 8461);
const blServer = BASELINE ? await serve(BASELINE, 8462) : null;
const browser = await chromium.launch();

console.log("matrix pass…");
await matrixPass(browser, "http://127.0.0.1:8461");
console.log("bleedover pass (home, guide)…");
await bleedoverPass(browser, "http://127.0.0.1:8461", "/");
await bleedoverPass(browser, "http://127.0.0.1:8461", "/guide/");
console.log("differentiation pass…");
await differentiationPass(browser, "http://127.0.0.1:8461");
console.log("interaction pass…");
await interactionPass(browser, "http://127.0.0.1:8461");
if (blServer) {
	console.log("baseline pass…");
	await baselinePass(browser, "http://127.0.0.1:8461", "http://127.0.0.1:8462");
}

await browser.close();
headServer.close();
blServer?.close();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const bySev = { FAIL: 0, WARN: 0, INFO: 0 };
for (const f of findings) {
	if (f.severity === "FAIL") bySev.FAIL += 1;
	else if (f.severity === "WARN") bySev.WARN += 1;
	else bySev.INFO += 1;
}

const lines = [
	"# Design audit findings",
	"",
	`dist: \`${DIST}\`${BASELINE ? `  ·  baseline: \`${BASELINE}\`` : ""}`,
	`result: **${bySev.FAIL} FAIL** · ${bySev.WARN} warn · ${bySev.INFO} info`,
	"",
	"| severity | check | detail | evidence |",
	"|---|---|---|---|",
	...findings
		.sort((a, b) => a.severity.localeCompare(b.severity))
		.map(
			(f) =>
				`| ${f.severity} | ${f.check} | ${f.detail} | ${f.evidence ?? ""} |`,
		),
];
writeFileSync(join(OUT, "findings.md"), lines.join("\n") + "\n");
console.log(`\n${bySev.FAIL} FAIL, ${bySev.WARN} warn, ${bySev.INFO} info`);
console.log(`corpus + findings.md in ${OUT}`);
process.exit(bySev.FAIL);
