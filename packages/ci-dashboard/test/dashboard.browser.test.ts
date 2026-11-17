/**
 * The built dashboard in Chrome, against a mocked read API built from the
 * provider's pact: the five views render, the what-if walks in the page, the
 * edit link goes to GitHub's editor, every request is a GET to the page's own
 * origin, the accessibility checks hold on every view, and each view matches
 * its screenshot in `test/visual/` (`UPDATE_VISUAL=1` rewrites them).
 *
 * It needs a Chrome or Chromium binary: `PLAYWRIGHT_CHROMIUM_PATH`,
 * Playwright's own, or a system Chrome. Without one it is skipped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { type Browser, chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_VIEWS, type DashboardView } from "../src/index.js";
import { PACT_NOW_MS, PACT_TOKEN } from "./support/pact-read-api.js";
import { type LocalDashboard, serveDashboard } from "./support/serve.js";

const VISUAL = new URL("./visual/", import.meta.url);
/** The share of pixels a screenshot may differ by before it is a regression. */
const VISUAL_TOLERANCE = 0.01;

async function launch(): Promise<Browser | undefined> {
	const candidates = [
		process.env.PLAYWRIGHT_CHROMIUM_PATH,
		undefined,
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	];
	for (const executablePath of candidates) {
		if (executablePath !== undefined && !existsSync(executablePath)) continue;
		try {
			return await chromium.launch(
				executablePath === undefined ? {} : { executablePath },
			);
		} catch {
			// Try the next binary.
		}
	}
	return undefined;
}

const browser = await launch();
if (browser === undefined)
	console.warn(
		"dashboard.browser.test.ts skipped: no Chrome or Chromium (set PLAYWRIGHT_CHROMIUM_PATH)",
	);

describe.skipIf(browser === undefined)("the dashboard in a browser", () => {
	let local: LocalDashboard;
	let page: Page;
	const requests: { method: string; url: string }[] = [];

	beforeAll(async () => {
		local = await serveDashboard();
		if (browser === undefined) throw new Error("skipped without a browser");
		const context = await browser.newContext({
			viewport: { width: 1280, height: 900 },
			colorScheme: "light",
			reducedMotion: "reduce",
		});
		page = await context.newPage();
		await page.clock.setFixedTime(PACT_NOW_MS);
		page.on("request", (request) =>
			requests.push({ method: request.method(), url: request.url() }),
		);
		await page.goto(`${local.origin}/dashboard#token=${PACT_TOKEN}`);
		await page.waitForSelector("#view section");
	});

	afterAll(async () => {
		await browser?.close();
		await local?.close();
	});

	async function open(view: DashboardView): Promise<void> {
		await page.evaluate((hash) => {
			location.hash = hash;
		}, `#/${view}`);
		await page.waitForFunction(
			(name) =>
				document
					.querySelector(`nav a[data-view="${name}"]`)
					?.getAttribute("aria-current") === "page" &&
				!document.getElementById("view")?.hasAttribute("aria-busy"),
			view,
		);
	}

	async function pick(repository: string): Promise<void> {
		await page.fill("#repository", repository);
		await page.click("#picker button[type=submit]");
		await page.waitForFunction(
			(name) =>
				document.getElementById("status")?.textContent?.includes(name) ?? false,
			repository,
		);
	}

	it("takes the token from the fragment and wipes it from the address", async () => {
		expect(page.url()).toBe(`${local.origin}/dashboard#/runners`);
		expect(
			await page.evaluate(() =>
				sessionStorage.getItem("hobo-ci-dashboard-token"),
			),
		).toBe(PACT_TOKEN);
		expect(await page.locator("#signin").isHidden()).toBe(true);
	});

	it("shows the Runners view with what needs attention first", async () => {
		await open("runners");
		const headings = await page.locator("#view h2").allTextContents();
		expect(headings[0]).toBe("Needs attention (1)");
		expect(await page.locator(".attention li").first().textContent()).toContain(
			"studio m-a: offline",
		);
		expect(headings).toContain("Machines (1)");
		expect(headings).toContain("Adopted runners (0)");
		expect(headings).toContain("Fleet");
	});

	it("names the command that reads GitHub when the relay keeps no run history", async () => {
		await open("signals");
		expect(await page.locator("#status").getAttribute("data-state")).toBe(
			"error",
		);
		expect(await page.locator("#status").textContent()).toContain(
			"hobo ci signals",
		);
	});

	it("shows the Router view, walks the what-if in the page, and edits through a pull request", async () => {
		await pick("octo/app");
		await open("router");
		expect(await page.locator("#order-heading").textContent()).toBe(
			"Runner order · octo/app",
		);
		const steps = await page
			.locator("#view table")
			.first()
			.locator("tbody tr td:nth-child(2)")
			.allTextContents();
		expect(steps).toEqual(["machine", "github"]);
		expect(await page.locator("#what-if-github").inputValue()).toBe(
			"ubuntu-24.04",
		);
		const before = requests.length;
		await page.fill("#what-if-machine", "self-hosted");
		await page.click("#what-if button[type=submit]");
		await page.waitForSelector("#what-if-answer.answer");
		const answer = (await page.locator("#what-if-answer").textContent()) ?? "";
		expect(answer).toContain("Routed to ubuntu-24.04 (github).");
		expect(answer).toContain("machine: no connected machine has those labels");
		expect(requests.length).toBe(before);
		const edit = page.locator('a[data-edit="runner-order"]');
		expect(await edit.getAttribute("href")).toBe(
			"https://github.com/octo/app/edit/HEAD/.hobo/ci.json",
		);
		expect(await edit.getAttribute("target")).toBe("_blank");
	});

	it("shows History and opens a run attempt with its jobs and step timings", async () => {
		await open("history");
		await page.click('a[href="#/history/octo/app/102/1"]');
		await page.waitForSelector("#run-heading");
		expect(await page.locator("#run-heading").textContent()).toBe(
			"CI · octo/app #102 attempt 1",
		);
		expect(
			await page.locator("#view article.job h3").allTextContents(),
		).toEqual(["test", "lint"]);
		expect(await page.locator("#view").textContent()).toContain("2m 58s");
	});

	it("shows Performance and Signals", async () => {
		await open("performance");
		expect(await page.locator("#view caption").allTextContents()).toEqual([
			"Times by workflow",
			"Times by job and runner",
			"Times by runner",
		]);
		await open("signals");
		expect(await page.locator("#view li.signal").count()).toBe(9);
		expect(await page.locator("#breakdown-heading").count()).toBe(1);
		expect(await page.locator("#trend-heading").count()).toBe(1);
	});

	it("sent only GET requests, only to its own origin", () => {
		expect(requests.length).toBeGreaterThan(8);
		for (const request of requests) {
			expect(request.method).toBe("GET");
			expect(new URL(request.url).origin).toBe(local.origin);
		}
		const paths = new Set(
			requests.map((request) => new URL(request.url).pathname),
		);
		for (const path of paths)
			expect(
				path === "/dashboard" ||
					path === "/dashboard/app.js" ||
					path.startsWith("/v1/accounts/self/"),
				path,
			).toBe(true);
	});

	it("passes the accessibility checks on every view", async () => {
		for (const view of DASHBOARD_VIEWS) {
			await open(view);
			const problems = await page.evaluate(() => {
				const found: string[] = [];
				const ids = [...document.querySelectorAll("[id]")].map(
					(node) => node.id,
				);
				const duplicate = ids.filter((id, index) => ids.indexOf(id) !== index);
				if (duplicate.length > 0)
					found.push(`duplicate ids: ${duplicate.join(", ")}`);
				if (document.querySelectorAll("h1").length !== 1) found.push("one h1");
				if (!document.documentElement.lang) found.push("html lang");
				for (const field of document.querySelectorAll<HTMLInputElement>(
					"input, select",
				)) {
					if (field.closest("[hidden]")) continue;
					if (
						(field.labels?.length ?? 0) === 0 &&
						!field.getAttribute("aria-label")
					)
						found.push(`unlabelled field ${field.name}`);
				}
				for (const table of document.querySelectorAll("table")) {
					if (!table.querySelector("caption"))
						found.push("table without caption");
					if (table.querySelectorAll("th[scope=col]").length === 0)
						found.push("table without column headers");
				}
				for (const section of document.querySelectorAll(
					"section[aria-labelledby]",
				)) {
					const id = section.getAttribute("aria-labelledby") ?? "";
					if (!document.getElementById(id))
						found.push(`section labelled by missing #${id}`);
				}
				for (const control of document.querySelectorAll<HTMLElement>(
					"a, button",
				)) {
					if (control.closest("[hidden]")) continue;
					if (
						(control.textContent ?? "").trim() === "" &&
						!control.getAttribute("aria-label")
					)
						found.push("control without a name");
				}
				for (const lamp of document.querySelectorAll(".lamp"))
					if (lamp.getAttribute("aria-hidden") !== "true")
						found.push("lamp not hidden from assistive tech");
				return found;
			});
			expect(problems, view).toEqual([]);
		}
	});

	it("shows a visible focus ring when moving by keyboard", async () => {
		await open("runners");
		await page.focus("#theme-toggle");
		await page.keyboard.press("Tab");
		const outline = await page.evaluate(() => {
			const active = document.activeElement;
			return active instanceof HTMLElement
				? `${active.dataset.view ?? active.tagName} ${getComputedStyle(active).outlineStyle} ${getComputedStyle(active).outlineWidth}`
				: "";
		});
		expect(outline).toBe("runners solid 3px");
	});

	it("matches its screenshots, by day and by night", async () => {
		mkdirSync(VISUAL, { recursive: true });
		await page.addStyleTag({ content: "body::after{display:none}" });
		const failures: string[] = [];
		for (const theme of ["light", "dark"] as const) {
			if ((await page.locator("html").getAttribute("data-theme")) !== theme)
				await page.click("#theme-toggle");
			await page.mouse.move(0, 0);
			expect(await page.locator("#theme-toggle").textContent()).toBe(
				theme === "dark" ? "Day" : "Night",
			);
			for (const view of DASHBOARD_VIEWS) {
				await open(view);
				const shot = PNG.sync.read(await page.screenshot({ fullPage: true }));
				const file = new URL(`${view}-${theme}.png`, VISUAL);
				if (process.env.UPDATE_VISUAL === "1" || !existsSync(file)) {
					writeFileSync(file, PNG.sync.write(shot));
					continue;
				}
				const baseline = PNG.sync.read(readFileSync(file));
				if (baseline.width !== shot.width || baseline.height !== shot.height) {
					failures.push(
						`${view}-${theme}: ${shot.width}x${shot.height}, baseline ${baseline.width}x${baseline.height}`,
					);
					continue;
				}
				const differing = pixelmatch(
					baseline.data,
					shot.data,
					undefined,
					shot.width,
					shot.height,
					{ threshold: 0.1 },
				);
				const share = differing / (shot.width * shot.height);
				if (share > VISUAL_TOLERANCE)
					failures.push(
						`${view}-${theme}: ${(share * 100).toFixed(2)}% of pixels differ`,
					);
			}
		}
		await page.click("#theme-toggle");
		expect(failures).toEqual([]);
	});
});
