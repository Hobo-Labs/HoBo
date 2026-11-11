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

/**
 * Wait until the trail has stopped: it says it is still, one stop is on (and
 * it is `at`, when given), the stop's sign has stood up and nothing finite is
 * still animating. A state, not a guessed duration, so a loaded runner only
 * makes the wait longer. On timeout the checks that follow report what is wrong.
 * The trail writes `data-travel` once a frame, so two frames pass first: a move
 * the last action began is on record before "still" is believed.
 */
async function settle(page: Page, at = ""): Promise<void> {
	await frames(page);
	await page
		.waitForFunction(
			(want) => {
				const trail = document.querySelector<HTMLElement>("[data-trail-page]");
				const on = document.querySelectorAll("[data-trail-stop].is-on");
				if (trail?.dataset.travel !== "still" || on.length !== 1 || (want !== "" && on[0].id !== want)) return false;
				if (trail.dataset.mode === "desk" && !document.querySelector(".tst-set.is-live")) return false;
				return document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Number.POSITIVE_INFINITY);
			},
			at,
			{ polling: 50, timeout: 15_000 },
		)
		.catch(() => console.log(`     (the trail did not settle${at ? ` at ${at}` : ""} within 15s)`));
}

/** Wait for a page condition; on timeout the check that follows reports it. */
async function until(page: Page, test: () => boolean): Promise<void> {
	await page.waitForFunction(test, undefined, { polling: 50, timeout: 15_000 }).catch(() => undefined);
}

/** Two animation frames: the page has seen a scroll or a style change. */
async function frames(page: Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/**
 * Wheel gestures dispatched inside the page. Each group's events go back to
 * back in one task (zero gap, so they are one stream whatever the runner's
 * load); groups are `gapMs` apart by the page's own timer, and load can only
 * lengthen that gap. Synthetic events have no default action, so an event no
 * listener takes scrolls the way the browser would: the nearest box under the
 * pointer that can scroll that way, else the window.
 */
async function wheel(page: Page, x: number, y: number, groups: readonly (readonly number[])[], gapMs = 0): Promise<void> {
	// No named functions inside: the runner's transform would wrap them in a
	// helper the page does not have.
	await page.evaluate(
		async (arg) => {
			for (const [i, group] of arg.groups.entries()) {
				if (i > 0 && arg.gapMs > 0) await new Promise((done) => setTimeout(done, arg.gapMs));
				for (const dy of group) {
					const at = document.elementFromPoint(arg.x, arg.y) ?? document.body;
					const init = { deltaY: dy, clientX: arg.x, clientY: arg.y, bubbles: true, cancelable: true, composed: true };
					if (!at.dispatchEvent(new WheelEvent("wheel", init))) continue;
					let box: Element | null = at;
					for (; box && box !== document.documentElement; box = box.parentElement) {
						const flow = getComputedStyle(box).overflowY;
						if ((flow === "auto" || flow === "scroll") && (dy > 0 ? box.scrollTop + box.clientHeight < box.scrollHeight - 1 : box.scrollTop > 0)) break;
					}
					if (box && box !== document.documentElement) box.scrollTop += dy;
					else scrollBy({ top: dy, behavior: "instant" });
				}
			}
		},
		{ x, y, groups, gapMs },
	);
}

/** Every stop at this size: what does not fit its box, and what focus cannot reach. */
async function fitAt(page: Page, origin: string, width: number, height: number): Promise<void> {
	await page.setViewportSize({ width, height });
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await settle(page);
	const count = await page.locator(".tst-mark").count();
	for (let i = 0; i < count; i++) {
		await page.locator(".tst-mark").nth(i).click();
		await settle(page);
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
			const sign = document.querySelector(".tst-set.is-alive .tst-sign")?.getBoundingClientRect();
			for (const label of document.querySelectorAll(".tst-route li span")) {
				const l = label.getBoundingClientRect();
				if (!sign || l.width === 0 || getComputedStyle(label).display === "none") continue;
				if (l.left < sign.right && l.right > sign.left && l.top < sign.bottom && l.bottom > sign.top)
					problems.push(`the "${label.textContent}" marker label overlaps the stop's sign`);
			}
			return { id: sec.id, problems };
		});
		check(`fit ${width}x${height} ${report.id}`, report.problems.length === 0, report.problems.slice(0, 3).join(" · "));
	}
}

/**
 * The comparison on a desktop: the card is its frame, so the table fits the
 * card with no sideways scroll and every cell's text inside its cell.
 */
async function deskTable(page: Page, origin: string, width: number, height: number): Promise<void> {
	await page.setViewportSize({ width, height });
	await page.goto(`${origin}/HoBo/#compare`, { waitUntil: "networkidle" });
	await settle(page);
	const report = await page.evaluate(() => {
		const card = document.querySelector<HTMLElement>("[data-trail-stop].is-on .stop-card-wide");
		const wrap = card?.querySelector<HTMLElement>(".table-wrap");
		const table = wrap?.querySelector<HTMLElement>("table.compare");
		if (!card || !wrap || !table) return { ok: false, detail: "no comparison card on the active stop" };
		const clipped = [...table.querySelectorAll<HTMLElement>("th, td")]
			.filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
			.map((cell) => cell.textContent?.trim() ?? "");
		const ok = table.scrollWidth <= card.clientWidth + 1 && wrap.scrollWidth <= wrap.clientWidth + 1 && clipped.length === 0;
		return {
			ok,
			detail: `table ${table.scrollWidth}px, wrap ${wrap.scrollWidth}/${wrap.clientWidth}px, card ${card.clientWidth}px${clipped.length ? `, clipped: ${clipped.slice(0, 3).join(" · ")}` : ""}`,
		};
	});
	check(`desk ${width}x${height}: the comparison fits its card`, report.ok, report.detail);
}

async function phone(page: Page, origin: string): Promise<void> {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await settle(page);
	const count = await page.locator(".tst-mark").count();
	for (let i = 0; i < count; i++) {
		await page.locator(".tst-mark").nth(i).click();
		await settle(page);
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

/**
 * A finger dragged from (x, from) to (x, to), through the browser's own touch
 * handling. The trail judges a swipe by distance alone; the moves are spaced
 * like a finger's so the browser reads a drag, and load can only slow it.
 */
async function swipe(page: Page, x: number, from: number, to: number): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
	for (let i = 1; i <= 8; i++) {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + ((to - from) * i) / 8 }] });
		await page.waitForTimeout(16);
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await cdp.detach();
}

async function phoneTouch(browser: Browser, origin: string): Promise<void> {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	const page = await context.newPage();
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await settle(page);
	// Find a stop whose sign in view is short: a tall one keeps swipes, by design.
	const shortSign = () =>
		page.evaluate(() => {
			for (const b of document.querySelectorAll<HTMLElement>(".tst-world .tst-board.is-up")) {
				const r = b.getBoundingClientRect();
				if (r.left >= 0 && r.right <= innerWidth && !b.querySelector(".tst-inner")?.classList.contains("is-tall"))
					return Math.round(r.top + r.height / 2);
			}
			return -1;
		});
	let y = await shortSign();
	for (let i = 1; y < 0 && i < 7; i++) {
		await page.locator(".tst-mark").nth(i).click();
		await settle(page);
		y = await shortSign();
	}
	// A swipe steps to the next sign, which may belong to the same stop: what
	// has to change is where the trail is, not which stop is marked.
	const where = () => page.evaluate(() => document.querySelector<HTMLElement>("[data-world]")?.style.transform ?? "");
	const before = await where();
	await swipe(page, 200, y, y - 260);
	await settle(page);
	const after = await where();
	check("phone: a swipe over a short sign moves the trail", y > 0 && after !== before, `sign at y ${y}, ${before} → ${after}`);

	// The code sign scrolls sideways, but an up-or-down swipe on it is the trail's.
	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await settle(page);
	await page.keyboard.press("ArrowRight");
	await settle(page);
	const code = await page.evaluate(() => {
		for (const pre of document.querySelectorAll<HTMLElement>(".tst-world .tst-board.is-up pre")) {
			const r = pre.getBoundingClientRect();
			if (r.left >= 0 && r.right <= innerWidth + 1 && r.top > 0 && r.bottom < innerHeight) return Math.round(r.top + r.height / 2);
		}
		return -1;
	});
	const onCode = await where();
	await swipe(page, 200, code, code - 220);
	await settle(page);
	const offCode = await where();
	check("phone: a swipe that starts on the code sign moves the trail", code > 0 && offCode !== onCode, `code at y ${code}, ${onCode} → ${offCode}`);

	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/#get-started`, { waitUntil: "networkidle" });
	await settle(page, "get-started");
	await page.locator("[data-next]").click({ force: true });
	await until(page, () => scrollY > 100 && (document.querySelector(".site-footer")?.getBoundingClientRect().top ?? 9999) < innerHeight);
	const viaNext = await page.evaluate(() => ({ y: scrollY, footer: Math.round(document.querySelector(".site-footer")?.getBoundingClientRect().top ?? 9999) }));
	check("phone: Next at the last stop reaches the footer", viaNext.y > 100 && viaNext.footer < 844, JSON.stringify(viaNext));

	await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
	await frames(page);
	await swipe(page, 200, 600, 250);
	await until(page, () => scrollY > 100);
	const viaSwipe = await page.evaluate(() => scrollY);
	check("phone: a swipe up at the last stop reaches the footer", viaSwipe > 100, `scrollY ${viaSwipe}`);
	await context.close();
}

/**
 * The comparison on a phone sign: every column there, every header and cell
 * reachable by scrolling the table sideways inside its sign, no page-level
 * sideways scroll, and an up-or-down swipe that starts on it still the trail's.
 */
async function phoneTable(browser: Browser, origin: string, width: number, height: number): Promise<void> {
	const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
	const page = await context.newPage();
	await page.goto(`${origin}/HoBo/#compare`, { waitUntil: "networkidle" });
	await settle(page);
	const at = `${width}x${height}`;
	// The sign holding the table, brought into view the way a reader would.
	const table = () =>
		page.evaluate(() => {
			for (const wrap of document.querySelectorAll<HTMLElement>(".tst-world .tst-board.is-up .table-wrap")) {
				const r = wrap.getBoundingClientRect();
				if (r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.top > 0 && r.bottom < innerHeight) {
					return { y: Math.round(r.top + Math.min(r.height, 120) / 2), x: Math.round(r.left + r.width / 2) };
				}
			}
			return null;
		});
	let spot = await table();
	for (let i = 0; !spot && i < 4; i++) {
		await swipe(page, Math.round(width / 2), Math.round(height * 0.7), Math.round(height * 0.7) - 260);
		await settle(page);
		spot = await table();
	}
	check(`phone ${at}: the comparison sign is in view`, spot !== null);
	if (!spot) {
		await context.close();
		return;
	}
	const reach = await page.evaluate(() => {
		const wrap = [...document.querySelectorAll<HTMLElement>(".tst-world .tst-board.is-up .table-wrap")].find((w) => {
			const r = w.getBoundingClientRect();
			return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1;
		});
		const problems: string[] = [];
		if (!wrap) return { columns: 0, cells: 0, problems: ["no table on a sign in view"], pageWide: 0 };
		const head = [...wrap.querySelectorAll<HTMLElement>("thead th")].filter((th) => getComputedStyle(th).display !== "none");
		const cells = [...wrap.querySelectorAll<HTMLElement>("th, td")];
		// The product column stays put; every other column scrolls in beside it.
		const lead = wrap.querySelector<HTMLElement>("tr > :first-child")?.offsetWidth ?? 0;
		for (const cell of cells) {
			if (getComputedStyle(cell).display === "none" || cell.getBoundingClientRect().width === 0) {
				problems.push(`hidden: ${cell.textContent?.trim()}`);
				continue;
			}
			// Scroll the table, not the page, until this cell is inside it and
			// nothing (the product column included) lies over it.
			wrap.scrollLeft = cell.cellIndex === 0 ? 0 : Math.max(0, cell.offsetLeft - lead - 4);
			const w = wrap.getBoundingClientRect();
			const c = cell.getBoundingClientRect();
			if (c.left < w.left - 1 || c.right > w.right + 1) problems.push(`out of reach: ${cell.textContent?.trim()}`);
			if (c.left < -1 || c.right > innerWidth + 1) problems.push(`off screen: ${cell.textContent?.trim()}`);
			const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)?.closest("th, td");
			if (hit !== cell) problems.push(`covered: ${cell.textContent?.trim()}`);
		}
		wrap.scrollLeft = 0;
		return {
			columns: head.length,
			cells: cells.length,
			problems,
			pageWide: document.documentElement.scrollWidth - innerWidth,
		};
	});
	check(`phone ${at}: the comparison keeps all four columns`, reach.columns === 4, `${reach.columns} header cells`);
	check(
		`phone ${at}: every header and cell is reachable by scrolling the table`,
		reach.cells > 0 && reach.problems.length === 0,
		reach.problems.slice(0, 3).join(" · "),
	);
	check(`phone ${at}: no sideways page scroll`, reach.pageWide <= 0, `${reach.pageWide}px too wide`);
	const where = () => page.evaluate(() => document.querySelector<HTMLElement>("[data-world]")?.style.transform ?? "");
	const before = await where();
	await swipe(page, spot.x, spot.y, spot.y - 220);
	await settle(page);
	const after = await where();
	check(`phone ${at}: a swipe that starts on the table moves the trail`, after !== before, `table at y ${spot.y}, ${before} → ${after}`);
	await context.close();
}

async function focusAndLinks(page: Page, origin: string): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await settle(page);
	await page.locator("#trailhead .btn-primary").focus();
	await page.keyboard.press("ArrowRight");
	await settle(page);
	const moved = await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName);
	check("focus: the keyboard carries focus to the next stop's heading", moved === "why-title", `focus on ${moved}`);
	const spoken = await page.evaluate(() => document.querySelector("[data-stage-said]")?.textContent ?? "");
	check("focus: a heading that takes focus is not announced twice", !spoken.includes("Why"), `live region: "${spoken}"`);
	await page.locator(".tst-mark").nth(3).click();
	await settle(page);
	const stayed = await page.evaluate(() => document.activeElement?.className ?? "");
	check("focus: a marker click leaves focus on the marker", stayed.includes("tst-mark"), `focus on ${stayed}`);
	check("links: moving on records the stop in the URL", new URL(page.url()).hash === "#vocabulary", page.url());

	// Arrival is a fresh load, not a hash change on the page already open.
	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/#roles`, { waitUntil: "networkidle" });
	await settle(page);
	const arrived = await page.evaluate(() => document.querySelector("[data-trail-stop].is-on")?.id);
	check("links: a hash names the stop on arrival", arrived === "roles", `at ${arrived}`);
	await page.evaluate(() => {
		location.hash = "#compare";
	});
	// The hashchange event comes in its own task: wait for the stop it names.
	await settle(page, "compare");
	const followed = await page.evaluate(() => document.querySelector("[data-trail-stop].is-on")?.id);
	check("links: a hashchange goes to the stop it names", followed === "compare", `at ${followed}`);

	// A nudged window (a rotated phone, a key that scrolled it) is still the trail.
	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/`, { waitUntil: "networkidle" });
	await settle(page);
	await page.evaluate(() => scrollTo({ top: 40, behavior: "instant" }));
	await frames(page);
	await page.mouse.click(700, 200);
	await page.keyboard.press("ArrowRight");
	await settle(page);
	const nudged = await page.evaluate(() => [...document.querySelectorAll("[data-trail-stop].is-on")].map((s) => s.id).join(","));
	check("keys: a small scroll does not leave the trail inert", nudged === "why", `at ${nudged}`);

	// One fast wheel burst is one step, and the stop it lands on starts at its heading.
	await page.setViewportSize({ width: 1280, height: 620 });
	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/#how`, { waitUntil: "networkidle" });
	await settle(page, "how");
	await page.evaluate(() => {
		const sec = document.querySelector<HTMLElement>("[data-trail-stop].is-on");
		if (sec) sec.scrollTop = sec.scrollHeight;
	});
	await wheel(page, 640, 300, [Array.from({ length: 14 }, () => 120)]);
	await settle(page);
	const burst = await page.evaluate(() => {
		const on = [...document.querySelectorAll<HTMLElement>("[data-trail-stop].is-on")];
		const sec = on[on.length - 1];
		const h = sec?.querySelector("h1, h2")?.getBoundingClientRect();
		const box = sec?.getBoundingClientRect();
		return { at: sec?.id, top: sec?.scrollTop, inView: Boolean(h && box && h.top >= box.top - 1 && h.bottom <= box.bottom + 1) };
	});
	check("wheel: a fast burst is one step and lands at the new stop's heading", burst.at === "vocabulary" && burst.inView, JSON.stringify(burst));
	await page.setViewportSize({ width: 1440, height: 900 });

	// Two deliberate flicks are two steps. A quarter second apart, the quiet
	// gap ends the first; the stop between (roles) fits at this size, so it
	// makes no difference whether load stretches the gap past the hand-over.
	// Back to back with no gap at all, the second's rise out of the first's
	// tail ends it, and it lands mid hand-over on a stop (how) that is taller
	// than its box here: a flick then steps on rather than reading it.
	const flick = [40, 90, 120, 100, 70, 45, 25, 10];
	for (const [gapMs, label, from, to] of [
		[250, "a quarter second apart", "vocabulary", "ai-native"],
		[0, "back to back", "why", "vocabulary"],
	] as const) {
		await page.goto("about:blank");
		await page.goto(`${origin}/HoBo/#${from}`, { waitUntil: "networkidle" });
		await settle(page, from);
		await wheel(page, 700, 300, [flick, flick], gapMs);
		await settle(page);
		const flicked = await page.evaluate(() => [...document.querySelectorAll("[data-trail-stop].is-on")].map((n) => n.id).join(","));
		check(`wheel: two flicks ${label} are two steps`, flicked === to, `${from} → ${flicked}`);
	}

	// A wheel-up gesture from the footer brings the trail back to its last stop
	// and never steps on past it, however long it runs.
	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/#get-started`, { waitUntil: "networkidle" });
	await settle(page, "get-started");
	await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
	await frames(page);
	await wheel(page, 700, 450, [Array.from({ length: 20 }, () => -120)]);
	await settle(page);
	const back = await page.evaluate(() => ({ at: [...document.querySelectorAll("[data-trail-stop].is-on")].map((n) => n.id).join(","), y: scrollY }));
	check("wheel: a burst up from the footer lands on the last stop", back.at === "get-started" && back.y === 0, JSON.stringify(back));

	// The last stop's Next goes on to the footer.
	await page.goto("about:blank");
	await page.goto(`${origin}/HoBo/#get-started`, { waitUntil: "networkidle" });
	await settle(page, "get-started");
	await page.locator("[data-next]").click({ force: true });
	await until(page, () => scrollY > 100 && (document.querySelector(".site-footer")?.getBoundingClientRect().top ?? 9999) < innerHeight);
	const nextFooter = await page.evaluate(() => ({ y: scrollY, footer: Math.round(document.querySelector(".site-footer")?.getBoundingClientRect().top ?? 9999) }));
	check("desktop: Next at the last stop reaches the footer", nextFooter.y > 100 && nextFooter.footer < 900, JSON.stringify(nextFooter));
	await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
	await frames(page);

	// Past the last stop the page lets go: the footer is a scroll away. One
	// real wheel event, so the browser's own scrolling is what is checked.
	await page.keyboard.press("End");
	await settle(page, "get-started");
	await page.mouse.move(700, 250);
	await page.mouse.wheel(0, 400);
	await until(page, () => scrollY > 100);
	const below = await page.evaluate(() => scrollY);
	check("scroll: past the last stop the wheel reaches the footer", below > 100, `scrollY ${below}`);
	await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));

	// Leaving the trail (another design) leaves nothing of it behind.
	await page.evaluate(() => {
		document.documentElement.dataset.design = "broadsheet";
	});
	await until(page, () => !document.querySelector("[data-trail-page]")?.classList.contains("is-staged"));
	await page.evaluate(() => document.dispatchEvent(new CustomEvent("hobo:motion")));
	await frames(page);
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
	for (const [w, h] of [
		[900, 560],
		[1024, 600],
		[1280, 620],
		[1280, 800],
		[1366, 657],
		[1440, 900],
	]) {
		await deskTable(page, origin, w, h);
	}
	await phone(page, origin);
	await phoneTouch(browser, origin);
	await phoneTable(browser, origin, 390, 844);
	await phoneTable(browser, origin, 360, 740);
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
