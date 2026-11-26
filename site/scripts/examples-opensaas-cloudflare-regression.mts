/**
 * Feature: Ship real Wasp OpenSaaS onto Cloudflare Temporary Accounts.
 *
 * Pool stamps CF station → Ship OpenSaaS → same-origin POST /api/cf-temp/opensaas
 * → wrangler deploy --temporary of examples/wasp-opensaas client → live workers.dev.
 * No mock broker. No wrangler login. No permanent API tokens.
 *
 * Run: HOBO_OPENSAAS_SKIP_BUILD=1 EXAMPLES_BASE_URL=… pnpm --filter hobo-site run examples:regression:opensaas
 * Pre-req: wasp build + vite build once under examples/wasp-opensaas/app; astro dev with Temporary Accounts plugin.
 */
import { chromium, type Browser, type Page } from "playwright";

const BASE = (
	process.env.EXAMPLES_BASE_URL ?? "http://127.0.0.1:4321/HoBo/"
).replace(/\/?$/u, "/");
const EXAMPLES_URL = `${BASE}examples/`;

function log(msg: string) {
	console.log(`[feature:opensaas-cloudflare] ${msg}`);
}

function examplesUrl(): string {
	const url = new URL(EXAMPLES_URL);
	url.searchParams.set("feature", "opensaas-cloudflare");
	url.searchParams.set("t", String(Date.now()));
	return url.toString();
}

async function assertApis(page: Page) {
	const health = await page.request.get(new URL("api/cf-temp/", BASE).toString());
	if (!health.ok()) {
		throw new Error(
			`cf-temp API down (${health.status()}). Start: pnpm --filter hobo-site run dev`,
		);
	}
	log("✓ same-origin Temporary Accounts API");
}

async function openConsole(page: Page) {
	await assertApis(page);
	await page.goto(examplesUrl(), { waitUntil: "networkidle", timeout: 60_000 });
	await page.evaluate(() => localStorage.clear());
	await page.goto(examplesUrl(), { waitUntil: "networkidle", timeout: 60_000 });
	await page.waitForFunction(
		() =>
			// SAFETY: assertion required at this I/O boundary.
			((document.querySelector("[data-yard-select]") as HTMLSelectElement | null)
				?.options.length ?? 0) > 0,
		null,
		{ timeout: 30_000 },
	);
}

async function runScenario(page: Page, browser: Browser) {
	log("Scenario: Deploy Cloudflare temporary station");
	await page.selectOption("[data-yard-select]", ["cloudflare"]);
	await page.click("[data-deploy-stations]");
	await page.waitForFunction(
		() => {
			const state = document.querySelector("[data-deploy-state]")?.textContent;
			return state === "stations-ready" || state === "failed";
		},
		null,
		{ timeout: 180_000 },
	);
	const stationSnap = await page.evaluate(() => ({
		state: document.querySelector("[data-deploy-state]")?.textContent ?? "",
		terminal: document.querySelector("[data-terminal]")?.textContent ?? "",
	}));
	if (stationSnap.state !== "stations-ready") {
		throw new Error(`station deploy failed:\n${stationSnap.terminal}`);
	}
	log("✓ Cloudflare station ready");

	log("Scenario: Ship OpenSaaS via Temporary Accounts");
	await page.selectOption("[data-app-select]", ["opensaas"]);
	await page.click("[data-deploy-apps]");
	await page.waitForFunction(
		() => {
			const state = document.querySelector("[data-deploy-state]")?.textContent;
			return state === "live" || state === "failed" || state === "stations-ready";
		},
		null,
		{ timeout: 600_000 },
	);
	const ship = await page.evaluate(() => {
		const terminal = document.querySelector("[data-terminal]")?.textContent ?? "";
		const state = document.querySelector("[data-deploy-state]")?.textContent ?? "";
		const frameEl = document.querySelector("[data-host-frame]");
		const frame = frameEl instanceof HTMLIFrameElement ? frameEl : null;
		const workers = terminal.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/giu) ?? [];
		const opensaasUrl =
			workers.find((url) => /opensaas/i.test(url)) ??
			workers.filter((url) => !/hobo-env-station/i.test(url)).at(-1) ??
			frame?.src ??
			"";
		return { state, terminal, opensaasUrl, frameSrc: frame?.src ?? "" };
	});
	if (/failed|error|unreachable|wrangler login|CLOUDFLARE_API_TOKEN/i.test(ship.terminal) &&
		!/✓.*OpenSaaS|✓.*opensaas/i.test(ship.terminal)) {
		throw new Error(`OpenSaaS ship failed:\n${ship.terminal}`);
	}
	if (!ship.opensaasUrl.includes(".workers.dev")) {
		throw new Error(
			`expected OpenSaaS workers.dev URL, got ${ship.opensaasUrl || ship.frameSrc}\n${ship.terminal}`,
		);
	}
	if (/blob:/i.test(ship.opensaasUrl)) {
		throw new Error("OpenSaaS ship used blob: — refusing");
	}
	log(`✓ OpenSaaS Temporary Accounts URL · ${ship.opensaasUrl}`);

	log("Scenario: Playwright navigates live OpenSaaS client");
	const appPage = await browser.newPage();
	let ok = false;
	let last = "";
	for (let attempt = 1; attempt <= 15; attempt++) {
		await appPage.goto(ship.opensaasUrl, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		last = await appPage.locator("body").innerText();
		if (/Open SaaS|OpenSaaS|Pricing|Get started|My Open SaaS/i.test(last)) {
			ok = true;
			break;
		}
		await appPage.waitForTimeout(2_000);
	}
	if (!ok) {
		throw new Error(
			`OpenSaaS page missing expected landing copy. body=${last.slice(0, 500)}`,
		);
	}
	await appPage.close();
	log("✓ Live OpenSaaS landing reachable");
}

async function main(): Promise<void> {
	log("Feature: OpenSaaS → Cloudflare Temporary Accounts (live)");
	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage({
			viewport: { width: 1400, height: 900 },
		});
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(String(error)));
		await openConsole(page);
		await runScenario(page, browser);
		if (pageErrors.length > 0) {
			throw new Error(`page errors: ${pageErrors.join(" | ")}`);
		}
		log("PASS");
	} finally {
		await browser?.close();
	}
}

await main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
