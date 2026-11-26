import {
	asPageUrl,
	currentLocationHref,
	isJsonObject,
	isJsonString,
	parseJsonTree,
	type JsonValue,
} from "../json-inspect.js";

/**
 * Vercel Drop Temporary Environment Station client for Examples.
 * Same-origin /api/vercel-temp — never VERCEL_TOKEN; never blob: as Vercel.
 * Docs: https://vercel.com/docs/drop
 */

export type VercelStationProvision = {
	readonly ok: true;
	readonly stationId: string;
	readonly stationUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly providerId: "vercel";
};

export type VercelBrokerError = {
	readonly ok: false;
	readonly error: string;
	readonly remediation?: string;
};

export function sameOriginVercelTempApiBase(
	pageUrl: string | URL,
	basePath = "/HoBo/",
): string {
	const page = asPageUrl(pageUrl);
	const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
	const prefix = base.length === 0 || base === "/" ? "" : base;
	return `${page.origin}${prefix}/api/vercel-temp`;
}

export function isVercelStationUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname.endsWith(".vercel.app") &&
			!parsed.username &&
			!parsed.password &&
			!parsed.port
		);
	} catch {
		return false;
	}
}

const REMEDIATION =
	"Vercel has no configured anonymous temporary API. Choose an available anonymous provider. HOBO_VERCEL_DROP_MOCK=1 enables an explicit offline replay; account-backed Vercel deployment requires a scoped credential.";

export async function provisionVercelStationViaBroker(input: {
	readonly stationId: string;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
}): Promise<VercelStationProvision> {
	const pageUrl =
		input.pageUrl ??
		currentLocationHref() ??
		"http://localhost:4321/HoBo/examples/";
	const base = (
		input.baseUrl ??
		sameOriginVercelTempApiBase(pageUrl, input.basePath ?? "/HoBo/")
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
			`${REMEDIATION} (API returned HTML/non-JSON HTTP ${response.status} — restart astro dev with current tree; GitHub Pages has no /api/vercel-temp)`,
		);
	}
	let body: JsonValue;
	try {
		body = parseJsonTree(text);
	} catch {
		throw new Error(`${REMEDIATION} (invalid JSON HTTP ${response.status})`);
	}
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		const fail = isJsonObject(body) ? body : {};
		throw new Error(
			(isJsonString(fail.remediation) ? fail.remediation : undefined) ??
				(isJsonString(fail.error) ? fail.error : undefined) ??
				REMEDIATION,
		);
	}
	if ("VERCEL_TOKEN" in body || "apiToken" in body) {
		throw new Error(
			"Vercel Drop broker leaked credentials to the browser — refusing response",
		);
	}
	if (!isJsonString(body.stationUrl) || !isVercelStationUrl(body.stationUrl)) {
		throw new Error(
			`Broker returned non-vercel.app stationUrl (${String(body.stationUrl)}). Refusing stand-ins as Vercel Drop.`,
		);
	}
	if (
		!isJsonString(body.claimUrl) ||
		!isJsonString(body.stationId) ||
		!isJsonString(body.expiresAt)
	) {
		throw new Error("Vercel Drop broker response missing claimUrl");
	}
	return {
		ok: true,
		stationId: body.stationId,
		stationUrl: body.stationUrl,
		claimUrl: body.claimUrl,
		expiresAt: body.expiresAt,
		anonymous: true,
		temporary: true,
		providerId: "vercel",
	};
}
