import {
	asPageUrl,
	currentLocationHref,
	isJsonObject,
	isJsonString,
	parseJsonTree,
	type JsonValue,
} from "../json-inspect.js";

/**
 * Generic temporary/agent Environment Station client for Examples providers
 * that expose provisionTemporaryEnvironmentStation (local or anonymous).
 */

export type ProviderTempProvision = {
	readonly ok: true;
	readonly stationId: string;
	readonly stationUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly providerId: string;
	readonly apiVersion?: string;
};

export type ProviderTempError = {
	readonly ok: false;
	readonly error: string;
	readonly remediation?: string;
};

export const PROVIDER_TEMP_IDS = Object.freeze([
	"browser-wasm",
	"webernetes",
	"netlify",
] as const);

export type ProviderTempId = (typeof PROVIDER_TEMP_IDS)[number];

export const PROVIDER_TEMP_API_VERSION = "hobo-temp-v2" as const;

export const PROVIDER_TEMP_API_MISSING =
	"Temporary station API returned HTML/non-JSON. Stale or static site has no /api/provider-temp. Restart: HOBO_NETLIFY_TEMP_MOCK=1 HOBO_LAKEBED_TEMP_MOCK=1 HOBO_VERCEL_DROP_MOCK=1 pnpm --filter hobo-site run dev (kill old :4321). GitHub Pages cannot provision remote yards.";

export function isProviderTempId(id: string): id is ProviderTempId {
	for (const candidate of PROVIDER_TEMP_IDS) {
		if (candidate === id) return true;
	}
	return false;
}

export function sameOriginProviderTempApiBase(
	pageUrl: string | URL,
	providerId: string,
	basePath = "/HoBo/",
): string {
	const page = asPageUrl(pageUrl);
	const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
	const prefix = base.length === 0 || base === "/" ? "" : base;
	return `${page.origin}${prefix}/api/provider-temp/${providerId}`;
}

async function readBrokerJson(
	response: Response,
	context: string,
): Promise<JsonValue> {
	const text = await response.text();
	const trimmed = text.trimStart();
	const contentType = response.headers.get("content-type") ?? "";
	const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
	if (
		trimmed.startsWith("<") ||
		(!contentType.includes("application/json") && !looksJson)
	) {
		throw new Error(
			`${context}: ${PROVIDER_TEMP_API_MISSING} (HTTP ${response.status})`,
		);
	}
	try {
		return parseJsonTree(text);
	} catch {
		throw new Error(
			`${context}: ${PROVIDER_TEMP_API_MISSING} (HTTP ${response.status}, invalid JSON)`,
		);
	}
}

export async function assertProviderTempApiReady(input: {
	readonly providerId: ProviderTempId;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly fetchImpl?: typeof fetch;
}): Promise<void> {
	const pageUrl =
		input.pageUrl ??
		currentLocationHref() ??
		"http://localhost:4321/HoBo/examples/";
	const base = sameOriginProviderTempApiBase(
		pageUrl,
		input.providerId,
		input.basePath ?? "/HoBo/",
	).replace(/\/$/u, "");
	const fetchImpl = input.fetchImpl ?? fetch;
	const response = await fetchImpl(base, {
		method: "GET",
		signal: AbortSignal.timeout(15_000),
	});
	const body = await readBrokerJson(
		response,
		`${input.providerId} temp health`,
	);
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		throw new Error(
			`${input.providerId} temp API not ready (HTTP ${response.status}). ${PROVIDER_TEMP_API_MISSING}`,
		);
	}
	if (body.apiVersion !== PROVIDER_TEMP_API_VERSION) {
		throw new Error(
			`${input.providerId} temp API stale (apiVersion=${String(body.apiVersion)}). Kill old astro dev and restart with current tree.`,
		);
	}
}

export async function provisionProviderTempStation(input: {
	readonly providerId: ProviderTempId;
	readonly stationId: string;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly fetchImpl?: typeof fetch;
}): Promise<ProviderTempProvision> {
	const pageUrl =
		input.pageUrl ??
		currentLocationHref() ??
		"http://localhost:4321/HoBo/examples/";
	const base = sameOriginProviderTempApiBase(
		pageUrl,
		input.providerId,
		input.basePath ?? "/HoBo/",
	).replace(/\/$/u, "");
	const fetchImpl = input.fetchImpl ?? fetch;

	await assertProviderTempApiReady({
		providerId: input.providerId,
		pageUrl,
		basePath: input.basePath,
		fetchImpl,
	});

	const response = await fetchImpl(`${base}/station`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stationId: input.stationId }),
		signal: AbortSignal.timeout(180_000),
	});
	const body = await readBrokerJson(
		response,
		`${input.providerId} temp station`,
	);
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		const fail = isJsonObject(body) ? body : {};
		throw new Error(
			(isJsonString(fail.remediation) ? fail.remediation : undefined) ??
				(isJsonString(fail.error) ? fail.error : undefined) ??
				`Temporary provision failed for ${input.providerId}`,
		);
	}
	if (
		!isJsonString(body.claimUrl) ||
		!isJsonString(body.stationUrl) ||
		!isJsonString(body.stationId) ||
		!isJsonString(body.expiresAt)
	) {
		throw new Error(`${input.providerId} temp broker missing stationUrl/claimUrl`);
	}
	const provisioned: ProviderTempProvision = {
		ok: true,
		stationId: body.stationId,
		stationUrl: body.stationUrl,
		claimUrl: body.claimUrl,
		expiresAt: body.expiresAt,
		anonymous: true,
		temporary: true,
		providerId: input.providerId,
	};
	if (isJsonString(body.apiVersion)) {
		return { ...provisioned, apiVersion: body.apiVersion };
	}
	return provisioned;
}
