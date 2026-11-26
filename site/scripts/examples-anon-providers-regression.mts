/**
 * Live regression: Examples temporary/agent Environment Station APIs.
 * Lakebed → /api/lakebed-temp (HOBO_LAKEBED_TEMP_MOCK=1 for CI).
 * Vercel Drop → /api/vercel-temp (HOBO_VERCEL_DROP_MOCK=1 for CI).
 * Netlify anonymous → /api/provider-temp/netlify (HOBO_NETLIFY_TEMP_MOCK=1 for CI).
 * Local yards → same-origin /api/anon/host via provider-temp.
 *
 * Run:
 *   HOBO_LAKEBED_TEMP_MOCK=1 HOBO_VERCEL_DROP_MOCK=1 HOBO_NETLIFY_TEMP_MOCK=1 \
 *   EXAMPLES_BASE_URL=http://127.0.0.1:4321/HoBo/ \
 *   pnpm --filter hobo-site run examples:regression:anon
 */
import { type JsonObject } from "../src/lib/json-inspect.js";
import { chromium, type Page } from "playwright";

const BASE = (
	process.env.EXAMPLES_BASE_URL ?? "http://127.0.0.1:4321/HoBo/"
).replace(/\/?$/u, "/");

const EXPECTED_API_VERSION = "hobo-temp-v2";

const LOCAL_PROVIDER_TEMP = [
	"browser-wasm",
	"webernetes",
] as const;

function log(msg: string) {
	console.log(`[feature:temp-providers] ${msg}`);
}

async function readJson(
	res: Awaited<ReturnType<Page["request"]["get"]>>,
	label: string,
): Promise<JsonObject> {
	const ct = res.headers()["content-type"] ?? "";
	const text = await res.text();
	if (text.trimStart().startsWith("<") || !ct.includes("application/json")) {
		throw new Error(
			`${label}: expected JSON, got ${ct || "unknown"} HTTP ${res.status()} (HTML usually means stale astro on this port — kill it and restart with mocks)`,
		);
	}
	// SAFETY: assertion required at this I/O boundary.
	return JSON.parse(text) as JsonObject;
}

async function assertLakebed(page: Page) {
	const health = await page.request.get(
		new URL("api/lakebed-temp", BASE).toString(),
	);
	const healthBody = await readJson(health, "lakebed-temp health");
	if (!health.ok() || healthBody.ok !== true) {
		throw new Error(
			`lakebed-temp API down (${health.status()}). Start: HOBO_LAKEBED_TEMP_MOCK=1 pnpm --filter hobo-site run dev`,
		);
	}
	if (healthBody.apiVersion !== EXPECTED_API_VERSION) {
		throw new Error(
			`lakebed-temp stale apiVersion=${String(healthBody.apiVersion)}`,
		);
	}
	const res = await page.request.post(
		new URL("api/lakebed-temp/station", BASE).toString(),
		{
			data: { stationId: "station:regression:lakebed" },
			timeout: 60_000,
		},
	);
	const body = await readJson(res, "lakebed-temp station");
	if (!res.ok() || body.ok !== true) {
		throw new Error(`lakebed station failed: ${String(body.error ?? res.status())}`);
	}
	const stationUrl = String(body.stationUrl ?? "");
	if (!stationUrl.includes("lakebed.")) {
		throw new Error(`lakebed stationUrl not Lakebed host: ${stationUrl}`);
	}
	if (!body.claimUrl) throw new Error("lakebed missing claimUrl");
	log(`✓ lakebed-temp · ${stationUrl}`);
}

async function assertVercelDrop(page: Page) {
	const health = await page.request.get(
		new URL("api/vercel-temp", BASE).toString(),
	);
	const healthBody = await readJson(health, "vercel-temp health");
	if (!health.ok() || healthBody.ok !== true) {
		throw new Error(
			`vercel-temp API down (${health.status()}). Start: HOBO_VERCEL_DROP_MOCK=1 pnpm --filter hobo-site run dev`,
		);
	}
	if (healthBody.apiVersion !== EXPECTED_API_VERSION) {
		throw new Error(
			`vercel-temp stale apiVersion=${String(healthBody.apiVersion)}`,
		);
	}
	const res = await page.request.post(
		new URL("api/vercel-temp/station", BASE).toString(),
		{
			data: { stationId: "station:regression:vercel" },
			timeout: 60_000,
		},
	);
	const body = await readJson(res, "vercel-temp station");
	if (!res.ok() || body.ok !== true) {
		throw new Error(`vercel Drop station failed: ${String(body.error ?? res.status())}`);
	}
	const stationUrl = String(body.stationUrl ?? "");
	if (!stationUrl.includes("vercel.app")) {
		throw new Error(`vercel stationUrl not *.vercel.app: ${stationUrl}`);
	}
	if (!body.claimUrl) throw new Error("vercel missing claimUrl");
	log(`✓ vercel-temp (Drop) · ${stationUrl}`);
}

async function assertNetlify(page: Page) {
	const health = await page.request.get(
		new URL("api/provider-temp/netlify", BASE).toString(),
	);
	const healthBody = await readJson(health, "provider-temp/netlify health");
	if (!health.ok() || healthBody.ok !== true) {
		throw new Error(
			`provider-temp/netlify down (${health.status()}). Start: HOBO_NETLIFY_TEMP_MOCK=1 pnpm --filter hobo-site run dev`,
		);
	}
	if (healthBody.apiVersion !== EXPECTED_API_VERSION) {
		throw new Error(
			`netlify temp stale apiVersion=${String(healthBody.apiVersion)} — kill old :4321 and restart`,
		);
	}
	const res = await page.request.post(
		new URL("api/provider-temp/netlify/station", BASE).toString(),
		{
			data: { stationId: "station:regression:netlify" },
			timeout: 180_000,
		},
	);
	const body = await readJson(res, "provider-temp/netlify station");
	if (!res.ok() || body.ok !== true) {
		throw new Error(
			`netlify station failed: ${String(body.error ?? body.remediation ?? res.status())}`,
		);
	}
	const stationUrl = String(body.stationUrl ?? "");
	if (!stationUrl.includes("netlify.app")) {
		throw new Error(`netlify stationUrl not *.netlify.app: ${stationUrl}`);
	}
	if (!body.claimUrl) throw new Error("netlify missing claimUrl");
	log(`✓ provider-temp/netlify · ${stationUrl}`);
}

async function assertLocalProviderTemp(page: Page, providerId: string) {
	const health = await page.request.get(
		new URL(`api/provider-temp/${providerId}`, BASE).toString(),
	);
	const healthBody = await readJson(health, `provider-temp/${providerId} health`);
	if (!health.ok() || healthBody.ok !== true) {
		throw new Error(
			`provider-temp/${providerId} down (${health.status()}). Restart astro with current tree.`,
		);
	}
	if (healthBody.apiVersion !== EXPECTED_API_VERSION) {
		throw new Error(
			`${providerId} temp stale apiVersion=${String(healthBody.apiVersion)}`,
		);
	}

	const res = await page.request.post(
		new URL(`api/provider-temp/${providerId}/station`, BASE).toString(),
		{
			data: { stationId: `station:regression:${providerId}` },
			timeout: 60_000,
		},
	);
	const body = await readJson(res, `provider-temp/${providerId} station`);
	if (!res.ok() || body.ok !== true) {
		throw new Error(
			`${providerId} temp station failed: ${String(body.error ?? res.status())}`,
		);
	}
	const url = String(body.stationUrl ?? "");
	if (!url.startsWith("http") || url.startsWith("blob:")) {
		throw new Error(`${providerId} bad stationUrl: ${url}`);
	}
	if (!url.includes("/api/anon/host/")) {
		throw new Error(
			`${providerId} expected same-origin anon host URL, got ${url}`,
		);
	}
	if (!body.claimUrl) throw new Error(`${providerId} missing claimUrl`);

	const host = await page.request.get(url);
	const hostText = await host.text();
	if (!host.ok() || !hostText.includes(`data-hobo-station="${providerId}"`)) {
		throw new Error(
			`${providerId} host not navigable (HTTP ${host.status()}): ${url}`,
		);
	}
	log(`✓ provider-temp/${providerId} · ${url}`);
}

async function assertCfTempHealth(page: Page) {
	const health = await page.request.get(new URL("api/cf-temp", BASE).toString());
	const body = await readJson(health, "cf-temp health");
	if (!health.ok() || body.ok !== true) {
		throw new Error(`cf-temp health failed HTTP ${health.status()}`);
	}
	if (body.apiVersion !== EXPECTED_API_VERSION) {
		throw new Error(
			`cf-temp stale apiVersion=${String(body.apiVersion)} — restart site`,
		);
	}
	log("✓ cf-temp health");
}

async function main() {
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	try {
		await assertCfTempHealth(page);
		await assertLakebed(page);
		await assertVercelDrop(page);
		await assertNetlify(page);
		for (const id of LOCAL_PROVIDER_TEMP) {
			await assertLocalProviderTemp(page, id);
		}
		log("all temporary/agent provider regressions green");
	} finally {
		await browser.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
