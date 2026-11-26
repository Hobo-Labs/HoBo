import {
	asPageUrl,
	currentLocationHref,
	isJsonObject,
	isJsonString,
	parseJsonTree,
	type JsonValue,
} from "../json-inspect.js";

/**
 * Lakebed anonymous Temporary Environment Station client for Examples.
 * Same-origin /api/lakebed-temp — never LAKEBED_TOKEN, never blob: as Lakebed.
 */

export type LakebedStationProvision = {
	readonly ok: true;
	readonly stationId: string;
	readonly stationUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly providerId: "lakebed";
};

export type LakebedBrokerError = {
	readonly ok: false;
	readonly error: string;
	readonly remediation?: string;
};

export function sameOriginLakebedTempApiBase(
	pageUrl: string | URL,
	basePath = "/HoBo/",
): string {
	const page = asPageUrl(pageUrl);
	const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
	const prefix = base.length === 0 || base === "/" ? "" : base;
	return `${page.origin}${prefix}/api/lakebed-temp`;
}

export function isLakebedStationUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return (
			host.endsWith(".lakebed.app") ||
			host.endsWith(".lakebed.dev") ||
			host === "lakebed.app" ||
			host === "lakebed.dev"
		);
	} catch {
		return false;
	}
}

const REMEDIATION =
	"Lakebed anonymous Temporary Accounts provision failed. Local: `pnpm --filter hobo-site run dev` (same-origin /api/lakebed-temp). CI/replay: set HOBO_LAKEBED_TEMP_MOCK=1. Never set LAKEBED_TOKEN for Examples stamps.";

export async function provisionLakebedStationViaBroker(input: {
	readonly stationId: string;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
}): Promise<LakebedStationProvision> {
	const pageUrl =
		input.pageUrl ??
		currentLocationHref() ??
		"http://localhost:4321/HoBo/examples/";
	const base = (
		input.baseUrl ??
		sameOriginLakebedTempApiBase(pageUrl, input.basePath ?? "/HoBo/")
	).replace(/\/$/u, "");
	const fetchImpl = input.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(`${base}/station`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ stationId: input.stationId }),
			signal: AbortSignal.timeout(180_000),
		});
	} catch (error) {
		throw new Error(
			`${REMEDIATION} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const text = await response.text();
	const trimmed = text.trimStart();
	const contentType = response.headers.get("content-type") ?? "";
	const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
	if (
		trimmed.startsWith("<") ||
		(!contentType.includes("application/json") && !looksJson)
	) {
		throw new Error(
			`${REMEDIATION} (API returned HTML/non-JSON HTTP ${response.status} — restart astro dev with current tree; GitHub Pages has no /api/lakebed-temp)`,
		);
	}
	let body: JsonValue;
	try {
		body = parseJsonTree(text);
	} catch {
		throw new Error(
			`${REMEDIATION} (invalid JSON HTTP ${response.status})`,
		);
	}
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		const fail = isJsonObject(body) ? body : {};
		throw new Error(
			(isJsonString(fail.remediation) ? fail.remediation : undefined) ??
				(isJsonString(fail.error) ? fail.error : undefined) ??
				REMEDIATION,
		);
	}
	if ("LAKEBED_TOKEN" in body || "apiToken" in body) {
		throw new Error(
			"Lakebed temp broker leaked credentials to the browser — refusing response",
		);
	}
	if (!isJsonString(body.stationUrl) || !isLakebedStationUrl(body.stationUrl)) {
		throw new Error(
			`Broker returned non-Lakebed stationUrl (${String(body.stationUrl)}). Refusing same-origin HTML stubs as Lakebed.`,
		);
	}
	if (
		!isJsonString(body.claimUrl) ||
		!isJsonString(body.stationId) ||
		!isJsonString(body.expiresAt)
	) {
		throw new Error("Lakebed broker response missing claimUrl");
	}
	return {
		ok: true,
		stationId: body.stationId,
		stationUrl: body.stationUrl,
		claimUrl: body.claimUrl,
		expiresAt: body.expiresAt,
		anonymous: true,
		temporary: true,
		providerId: "lakebed",
	};
}
