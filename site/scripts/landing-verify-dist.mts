/**
 * The landing page's trail, checked against the BUILT site.
 *
 * The trail turns the landing page into a row of stops that fill one screen
 * between the header and the band. That only works if every stop's content
 * can actually be read there, at the sizes people use, so this serves `dist/`
 * statically (what Pages does) and checks, in a real browser:
 *
 *   1. fit: at 900x560, 1024x600, 1280x620, 1366x657 and 1440x900, for every
 *      stop: nothing starts above its scroll box, the box sits between the
 *      header and the band, and every link or button in it, once focused, is
 *      on screen and not covered by anything
 *   2. phone: at 390x844, every sign stands below the trail marker
 *   3. focus: moving on from the keyboard while reading a stop takes focus to
 *      the next stop's heading; a marker click leaves it on the marker
 *   4. links: a hash names a stop on arrival and on hashchange, and moving on
 *      records the stop in the URL
 *   5. no uncaught errors on the way
 *
 * Usage:
 *   node --import tsx scripts/landing-verify-dist.mts [--dist dist] [--port 0]
 *
 * Exit code 0 = the trail reads at every size checked; non-zero = do not publish.
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1] ?? "");

const DIST = resolve(args.get("--dist") ?? "dist");
const PORT = Number(args.get("--port") ?? 0);

const TYPES = new Map([
	[".html", "text/html"],
	[".css", "text/css"],
	[".js", "text/javascript"],
	[".json", "application/json"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".webp", "image/webp"],
	[".txt", "text/plain"],
]);

function serve(dist: string, port: number): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
		let path = url.startsWith("/HoBo") ? url.slice("/HoBo".length) : url;
		if (path === "" || path.endsWith("/")) path += "index.html";
		let file = join(dist, path);
		if (!existsSync(file) && existsSync(join(dist, path, "index.html"))) file = join(dist, path, "index.html");
		if (!existsSync(file)) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		res.writeHead(200, { "content-type": TYPES.get(extname(file)) ?? "application/octet-stream" });
		res.end(readFileSync(file));
	});
	return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

/** Every stop at this size: what does not fit its box, and what focus cannot reach. */
async function fitAt(page: Page, origin: string, width: number, height: number): Promise<void> {
	await page.setViewportSize({ width, height });
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await page.waitForTimeout(500);
	const count = await page.locator(".tst-mark").count();
	for (let i = 0; i < count; i++) {
		await page.locator(".tst-mark").nth(i).click();
		await page.waitForTimeout(1400);
		const report = await page.evaluate(() => {
			const sec = document.querySelector<HTMLElement>("[data-trail-stop].is-on");
			const header = document.querySelector(".site-header")?.getBoundingClientRect();
			const band = document.querySelector(".tst-route")?.getBoundingClientRect();
			if (!sec || !header || !band) return { id: "?", problems: ["no active stop, header or band"] };
			const problems: string[] = [];
			sec.scrollTop = 0;
			const box = sec.getBoundingClientRect();
			if (box.top < header.bottom - 1) problems.push(`box starts ${Math.round(header.bottom - box.top)}px under the header`);
			if (box.bottom > band.top + 24) problems.push(`box ends ${Math.round(box.bottom - band.top)}px into the band`);
			const scrolls = getComputedStyle(sec).overflowY;
			for (const el of sec.querySelectorAll<HTMLElement>("h1, h2, h3, p, a, li, th, td, button, code")) {
				const r = el.getBoundingClientRect();
				if (r.height === 0) continue;
				if (r.top < box.top - 1) problems.push(`${el.tagName} "${el.textContent?.trim().slice(0, 30)}" starts ${Math.round(box.top - r.top)}px above its box`);
				if (r.bottom > box.bottom + 1 && scrolls !== "auto" && scrolls !== "scroll") problems.push(`${el.tagName} "${el.textContent?.trim().slice(0, 30)}" is below its box and the box does not scroll`);
			}
			for (const el of sec.querySelectorAll<HTMLElement>("a[href], button, [tabindex='0']")) {
				el.focus();
				const r = el.getBoundingClientRect();
				const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 8));
				if (r.top < box.top - 1 || r.bottom > box.bottom + 1 || !hit || !(el === hit || el.contains(hit)))
					problems.push(`focused ${el.tagName} "${el.textContent?.trim().slice(0, 24)}" is hidden or covered`);
			}
			sec.scrollTop = 0;
			return { id: sec.id, problems };
		});
		check(`fit ${width}x${height} ${report.id}`, report.problems.length === 0, report.problems.slice(0, 3).join(" · "));
	}
}

async function phone(page: Page, origin: string): Promise<void> {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await page.waitForTimeout(500);
	const count = await page.locator(".tst-mark").count();
	for (let i = 0; i < count; i++) {
		await page.locator(".tst-mark").nth(i).click();
		await page.waitForTimeout(2600);
		const report = await page.evaluate(() => {
			const route = document.querySelector(".tst-route")?.getBoundingClientRect();
			const problems: string[] = [];
			for (const b of document.querySelectorAll<HTMLElement>(".tst-world .tst-board.is-up")) {
				const r = b.getBoundingClientRect();
				if (r.right < 0 || r.left > innerWidth) continue;
				if (route && r.top < route.bottom - 6) problems.push(`a sign rises ${Math.round(route.bottom - r.top)}px under the trail marker`);
			}
			return problems;
		});
		check(`phone 390x844 stop ${i}`, report.length === 0, report.slice(0, 2).join(" · "));
	}
}

async function focusAndLinks(page: Page, origin: string): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await page.waitForTimeout(500);
	await page.locator("#trailhead .btn-primary").focus();
	await page.keyboard.press("ArrowRight");
	await page.waitForTimeout(1500);
	const moved = await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName);
	check("focus: the keyboard carries focus to the next stop's heading", moved === "why-title", `focus on ${moved}`);
	await page.locator(".tst-mark").nth(3).click();
	await page.waitForTimeout(1500);
	const stayed = await page.evaluate(() => document.activeElement?.className ?? "");
	check("focus: a marker click leaves focus on the marker", stayed.includes("tst-mark"), `focus on ${stayed}`);
	check("links: moving on records the stop in the URL", new URL(page.url()).hash === "#vocabulary", page.url());

	// Arrival is a fresh load, not a hash change on the page already open.
	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/#roles`, { waitUntil: "networkidle" });
	await page.waitForTimeout(800);
	const arrived = await page.evaluate(() => document.querySelector("[data-trail-stop].is-on")?.id);
	check("links: a hash names the stop on arrival", arrived === "roles", `at ${arrived}`);
	await page.evaluate(() => {
		location.hash = "#compare";
	});
	// Long enough for the hand-over to finish: until then both stops are on.
	await page.waitForTimeout(2500);
	const followed = await page.evaluate(() => document.querySelector("[data-trail-stop].is-on")?.id);
	check("links: a hashchange goes to the stop it names", followed === "compare", `at ${followed}`);

	// A nudged window (a rotated phone, a key that scrolled it) is still the trail.
	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await page.waitForTimeout(500);
	await page.evaluate(() => scrollTo(0, 40));
	await page.mouse.click(700, 200);
	await page.keyboard.press("ArrowRight");
	await page.waitForTimeout(2000);
	const nudged = await page.evaluate(() => [...document.querySelectorAll("[data-trail-stop].is-on")].map((s) => s.id).join(","));
	check("keys: a small scroll does not leave the trail inert", nudged === "why", `at ${nudged}`);

	// Past the last stop the page lets go: the footer is a scroll away.
	await page.keyboard.press("End");
	await page.waitForTimeout(2200);
	await page.mouse.move(700, 250);
	await page.mouse.wheel(0, 400);
	await page.waitForTimeout(800);
	const below = await page.evaluate(() => scrollY);
	check("scroll: past the last stop the wheel reaches the footer", below > 100, `scrollY ${below}`);
	await page.evaluate(() => scrollTo(0, 0));

	// Leaving the trail (another design) leaves nothing of it behind.
	await page.evaluate(() => {
		document.documentElement.dataset.design = "broadsheet";
	});
	await page.waitForTimeout(300);
	await page.evaluate(() => document.dispatchEvent(new CustomEvent("hobo:motion")));
	const leftover = await page.evaluate(() => ({
		pause: document.querySelector<HTMLElement>("[data-pause]")?.hidden,
		staged: document.querySelector("[data-trail-page]")?.classList.contains("is-staged"),
	}));
	check("teardown: no pause button or trail survives another design", leftover.pause === true && leftover.staged === false, JSON.stringify(leftover));
}

const server = await serve(DIST, PORT);
// SAFETY: a server listening on a TCP port always reports an AddressInfo.
const { port } = server.address() as AddressInfo;
const origin = `http://127.0.0.1:${port}`;
let browser: Browser | null = null;
try {
	const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
	browser = await chromium.launch(executablePath ? { executablePath } : {});
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	for (const [w, h] of [
		[900, 560],
		[1024, 600],
		[1280, 620],
		[1366, 657],
		[1440, 900],
	]) {
		await fitAt(page, origin, w, h);
	}
	await phone(page, origin);
	await focusAndLinks(page, origin);
	check("page: no uncaught errors", errors.length === 0, errors.slice(0, 3).join(" · "));
} finally {
	await browser?.close();
	server.close();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed — do not publish this dist.`);
	process.exit(1);
}
console.log("\ndist verified: every stop of the trail reads at every size checked.");
