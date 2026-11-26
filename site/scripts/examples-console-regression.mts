/**
 * Feature: Operator deploys a real Cloudflare temporary Environment Station.
 *
 * Pool → Deploy stations POSTs same-origin `/api/cf-temp/station` (Astro Vite
 * middleware → Temporary Accounts REST). Receives a navigable `*.workers.dev`
 // SAFETY: assertion required at this I/O boundary.
 * URL + claim URL. Never stamps `blob:` as Cloudflare. Never mocks success.
 *
 * Run: pnpm --filter hobo-site run examples:regression
 * Requires: `astro dev` on EXAMPLES_BASE_URL (default http://127.0.0.1:4321/HoBo/)
 * with temporaryStationApiPlugin, plus network to api.cloudflare.com.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BASE = (
	process.env.EXAMPLES_BASE_URL ?? "http://127.0.0.1:4321/HoBo/"
).replace(/\/?$/u, "/");
const EXAMPLES_URL = `${BASE}examples/`;

const BANNED_YARD_PATTERNS = [
	/\bwaspApp\b/u,
	/\bcli\s*:/u,
	/examples\/try-site\/apps\//u,
	/wasp-opensaas/u,
] as const;

function log(msg: string) {
	console.log(`[feature:cloudflare-station] ${msg}`);
}

async function assertYardSurfacesStationOnly() {
	const yardsRoot = path.join(REPO_ROOT, "examples/try-site/yards");
	const files = (await readdir(yardsRoot)).filter((name) =>
		name.endsWith(".deploy.ts"),
	);
	if (files.length === 0) throw new Error("no yard deploy surfaces found");
	for (const name of files) {
		const source = await readFile(path.join(yardsRoot, name), "utf8");
		for (const pattern of BANNED_YARD_PATTERNS) {
			if (pattern.test(source)) {
				throw new Error(
					`yard ${name} must not include ${pattern}: station deploy surfaces cannot ship Bindle/app code`,
				);
			}
		}
		if (!/export\s*\{[\s\S]*\bas default\b/u.test(source)) {
			throw new Error(`yard ${name} must be a minimal provider default re-export`);
		}
		if (/\bcapabilities\s*:/u.test(source) || /\bstationBootstrap\b/u.test(source)) {
			throw new Error(
				`yard ${name} must not hand-list capabilities/stationBootstrap — provider plugins own those`,
			);
		}
	}
	log(`✓ ${files.length} yard surfaces are minimal provider re-exports`);
}

function examplesUrl(): string {
	const url = new URL(EXAMPLES_URL);
	url.searchParams.set("feature", "cloudflare-station");
	url.searchParams.set("t", String(Date.now()));
	// Do NOT pin stationBroker to a mock — localhost must use same-origin API.
	return url.toString();
}

async function assertSameOriginApiAlive(page: Page) {
	const apiBase = new URL("api/cf-temp/", BASE).toString().replace(/\/$/u, "");
	const response = await page.request.get(apiBase);
	if (!response.ok()) {
		throw new Error(
			`Same-origin Temporary Accounts API not reachable at ${apiBase} (HTTP ${response.status()}). Start site with \`pnpm --filter hobo-site run dev\` (temporaryStationApiPlugin).`,
		);
	}
	type CfTempHealth = { ok?: boolean; temporaryAccounts?: boolean };
	// SAFETY: cf-temp health JSON is decoded at this test boundary.
	const body = (await response.json()) as CfTempHealth;
	if (!body.ok || !body.temporaryAccounts) {
		throw new Error(`Unexpected cf-temp health: ${JSON.stringify(body)}`);
	}
	log(`✓ same-origin Temporary Accounts API · ${apiBase}`);
}

async function openConsole(page: Page) {
	await assertSameOriginApiAlive(page);
	await page.goto(examplesUrl(), { waitUntil: "networkidle", timeout: 60_000 });
	await page.evaluate(() => localStorage.clear());
	await page.goto(examplesUrl(), { waitUntil: "networkidle", timeout: 60_000 });
	await page.waitForFunction(() => {
		const select = document.querySelector("[data-yard-select]");
		return select instanceof HTMLSelectElement && select.options.length > 0;
	}, null, { timeout: 30_000 });
}

async function runScenario(page: Page, browser: Browser) {
	log("Scenario: select Cloudflare yard → Pool Code is provider-import station authoring");
	await page.locator("[data-yard-trigger]").click();
	const cloudflare = page.locator('[data-yard-option="cloudflare"]');
	if ((await cloudflare.getAttribute("aria-pressed")) !== "true") {
		await cloudflare.click();
	} else {
		await page.keyboard.press("Escape");
	}
	const code = page.locator('[data-pool-view="code"]');
	if ((await code.getAttribute("aria-pressed")) !== "true") await code.click();
	await page.waitForFunction(
		() =>
			document.querySelector("[data-pool-source-path]")?.textContent?.includes(
				"station.deploy.ts",
			) === true,
		null,
		{ timeout: 10_000 },
	);
	const source = await page.locator("[data-pool-source]").innerText();
	for (const pattern of BANNED_YARD_PATTERNS) {
		if (pattern.test(source)) {
			throw new Error(`Pool Code still exposes banned field matching ${pattern}`);
		}
	}
	if (!source.includes("@hobo/provider-cloudflare")) {
		throw new Error("Pool Code missing @hobo/provider-cloudflare import");
	}
	if (!/export default station\(\{\s*yards:/u.test(source)) {
		throw new Error("Pool Code missing export default station({ yards: … })");
	}
	if (/\bcapabilities\b/u.test(source) || /\bstationBootstrap\b/u.test(source)) {
		throw new Error("Pool Code must not hand-list capabilities/stationBootstrap");
	}
	log("✓ Cloudflare yard Pool Code is provider-import station authoring");

	log("Scenario: Deploy stations → live Temporary Accounts workers.dev");
	await page.selectOption("[data-yard-select]", ["cloudflare"]);
	const planLine = await page.locator("[data-station-plan-line]").innerText();
	if (planLine.includes("not-in-resource-pool")) {
		throw new Error(`Cloudflare still blocked by policy: ${planLine}`);
	}
	await page.click("[data-deploy-stations]");
	await page.waitForFunction(
		() => {
			const state = document.querySelector("[data-deploy-state]")?.textContent;
			return state === "stations-ready" || state === "failed";
		},
		null,
		{ timeout: 180_000 },
	);
	const snap = await page.evaluate(() => {
		const state = document.querySelector("[data-deploy-state]")?.textContent ?? "";
		const terminal = document.querySelector("[data-terminal]")?.textContent ?? "";
		const stationEl = document.querySelector("[data-station-select]");
		const stationValue =
			stationEl instanceof HTMLSelectElement ? stationEl.value : "";
		const shipLocked =
			document.querySelector('[data-board="ship"]')?.getAttribute("data-locked") ??
			"";
		const raw = localStorage.getItem("hobo-examples-stations");
		type StationSnap = {
			stations?: Array<{
				targetId?: string;
				endpointUrl?: string;
				claimUrl?: string;
			}>;
		};
		// SAFETY: localStorage registry JSON is decoded at this test boundary.
		const registry: StationSnap = raw
			? (JSON.parse(raw) as StationSnap)
			: { stations: [] };
		const cf = registry.stations?.find((entry) => entry.targetId === "cloudflare");
		return {
			state,
			terminal,
			stationValue,
			shipLocked,
			endpointUrl: cf?.endpointUrl ?? "",
			claimUrl: cf?.claimUrl ?? "",
		};
	});
	if (snap.state !== "stations-ready") {
		throw new Error(`station deploy failed:\n${snap.terminal}`);
	}
	if (/bridge unreachable|examples:bridge|Docker required/i.test(snap.terminal)) {
		throw new Error(`station path still demands bridge/Docker:\n${snap.terminal}`);
	}
	if (/CORS relay unreachable|hobo-cors-relay\.workers\.dev/i.test(snap.terminal)) {
		throw new Error(
			`station path still hits dead/external CORS relay:\n${snap.terminal}`,
		);
	}
	if (/blob:/i.test(snap.terminal) || snap.endpointUrl.startsWith("blob:")) {
		throw new Error(`Cloudflare path still used blob: station:\n${snap.terminal}`);
	}
	if (
		!snap.endpointUrl.endsWith(".workers.dev") &&
		!snap.endpointUrl.includes(".workers.dev")
	) {
		throw new Error(`expected workers.dev endpoint, got ${snap.endpointUrl}`);
	}
	if (snap.endpointUrl.includes("hobo-try-station-demo.preview.workers.dev")) {
		throw new Error(
			`got mocked demo workers.dev URL — regression must use live Temporary Accounts: ${snap.endpointUrl}`,
		);
	}
	if (!snap.claimUrl.includes("claim")) {
		throw new Error(`expected claim URL, got ${snap.claimUrl}`);
	}
	if (!snap.stationValue.includes("cloudflare")) {
		throw new Error(`expected Cloudflare station, got ${snap.stationValue}`);
	}
	if (snap.shipLocked === "true") {
		throw new Error("Ship stayed locked after Cloudflare station deploy");
	}
	log(`✓ Cloudflare temporary station ready · ${snap.endpointUrl}`);

	log("Scenario: navigate Playwright to live workers.dev station URL");
	const stationPage = await browser.newPage();
	const rootUrl = `${snap.endpointUrl.replace(/\/$/u, "")}/`;
	let marker: string | null = null;
	let lastBody = "";
	// Temporary Accounts edge often returns 1042/1104/"nothing here yet" for ~30–90s.
	for (let attempt = 1; attempt <= 40; attempt++) {
		await stationPage.goto(rootUrl, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		marker = await stationPage
			.locator("[data-hobo-station]")
			.count()
			.then(async (count) =>
				count > 0
					? stationPage.locator("[data-hobo-station]").getAttribute("data-hobo-station")
					: null,
			);
		lastBody = await stationPage.locator("body").innerText();
		if (marker === "cloudflare") break;
		if (
			/error code:\s*10(42|41|4)|nothing here yet|1104/i.test(lastBody)
		) {
			log(`· edge not ready (attempt ${attempt}/40)`);
		}
		if (attempt < 40) await stationPage.waitForTimeout(3_000);
	}
	if (marker !== "cloudflare") {
		throw new Error(
			`expected data-hobo-station=cloudflare, got ${marker}. body=${lastBody.slice(0, 400)}`,
		);
	}
	await stationPage.goto(`${snap.endpointUrl.replace(/\/$/u, "")}/health`, {
		waitUntil: "domcontentloaded",
		timeout: 30_000,
	});
	type StationHealth = { provider?: string; ok?: boolean };
	// SAFETY: station health JSON is decoded at this test boundary.
	const healthJson = (await stationPage.evaluate(() =>
		JSON.parse(document.body.innerText),
	)) as StationHealth;
	if (!healthJson?.ok || healthJson.provider !== "cloudflare") {
		throw new Error(`station health JSON unexpected: ${JSON.stringify(healthJson)}`);
	}
	await stationPage.close();
	log("✓ Navigated to live workers.dev station · health JSON ok");
}

async function main(): Promise<void> {
	log("Feature: Cloudflare temporary Environment Station (live Temporary Accounts)");
	await assertYardSurfacesStationOnly();

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
