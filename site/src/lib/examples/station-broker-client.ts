import {
	asPageUrl,
	currentLocationHref,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json-inspect.js";

type StationBrokerGlobal = typeof globalThis & {
	HOBO_STATION_BROKER_URL?: string;
};

function stationBrokerGlobal(): StationBrokerGlobal {
	// SAFETY: we only read/write HOBO_STATION_BROKER_URL on globalThis.
	return globalThis as StationBrokerGlobal;
}

/** Cloudflare Temporary Accounts entry for Examples — same-origin or CORS relay. */

/**
 * Dead placeholder previously shipped as default. DNS does not resolve.
 * Kept only so tests can assert we no longer treat it as a working broker.
 */
export const LEGACY_DEAD_CORS_RELAY_URL =
	"https://hobo-cors-relay.workers.dev";

export type TemporaryStationProvision = {
	readonly ok: true;
	readonly stationId: string;
	readonly scriptName: string;
	readonly stationUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
};

export type StationBrokerError = {
	readonly ok: false;
	readonly error: string;
	readonly remediation?: string;
};

export type ResolveStationBrokerInput = {
	readonly override?: string | null;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly envBrokerUrl?: string | null;
};

/** Same-origin Temporary Accounts API served by `astro dev` / preview middleware. */
export function sameOriginTemporaryStationApiBase(
	pageUrl: string | URL,
	basePath = "/HoBo/",
): string {
	const page = asPageUrl(pageUrl);
	const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
	const prefix = base.length === 0 || base === "/" ? "" : base;
	return `${page.origin}${prefix}/api/cf-temp`;
}

export function isLocalWebsiteHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1"
	);
}

/**
 * Resolve Temporary Accounts broker base.
 * Priority: explicit override → env → global override → localhost same-origin API.
 * Never falls back to the dead hobo-cors-relay.workers.dev host.
 */
export function resolveStationBrokerBase(
	input: ResolveStationBrokerInput | string | undefined = undefined,
): string {
	const opts: ResolveStationBrokerInput = isJsonString(input)
		? { override: input }
		: (input ?? {});

	const globalOverride = stationBrokerGlobal().HOBO_STATION_BROKER_URL;

	const candidates = [opts.override, opts.envBrokerUrl, globalOverride];
	for (const raw of candidates) {
		const trimmed = isJsonString(raw) ? raw.trim() : "";
		if (!trimmed) continue;
		if (trimmed === LEGACY_DEAD_CORS_RELAY_URL) continue;
		return trimmed.replace(/\/$/u, "");
	}

	const pageUrl = opts.pageUrl ?? currentLocationHref();
	if (pageUrl) {
		const page = asPageUrl(pageUrl);
		if (isLocalWebsiteHost(page.hostname)) {
			return sameOriginTemporaryStationApiBase(
				page,
				opts.basePath ??
					(globalThis.document === undefined
						? undefined
						: document.querySelector<HTMLElement>("[data-examples-console]")
								?.dataset.base) ??
					"/HoBo/",
			);
		}
	}

	throw new Error(
		"No Temporary Accounts broker configured. On localhost, run `pnpm --filter hobo-site run dev` (same-origin /api/cf-temp). On GitHub Pages, set PUBLIC_HOBO_STATION_BROKER_URL to a live Temporary Accounts CORS relay from `pnpm exec tsx scripts/bootstrap-cf-cors-relay.mts`. Blob URLs are not Cloudflare.",
	);
}

/** Apply `?stationBroker=` / `data-station-broker` before Deploy stations. */
export function applyStationBrokerUrlOverride(
	raw: string | null | undefined,
): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed || trimmed === LEGACY_DEAD_CORS_RELAY_URL) {
		delete stationBrokerGlobal().HOBO_STATION_BROKER_URL;
		return undefined;
	}
	const normalized = trimmed.replace(/\/$/u, "");
	stationBrokerGlobal().HOBO_STATION_BROKER_URL = normalized;
	return normalized;
}

export function isWorkersDevStationUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host.endsWith(".workers.dev");
	} catch {
		return false;
	}
}

const RELAY_REMEDIATION =
	"Cloudflare Temporary Accounts broker unreachable. Local: use `pnpm --filter hobo-site run dev` (same-origin /api/cf-temp). Remote: bootstrap CORS relay via Temporary Accounts (`pnpm exec tsx scripts/bootstrap-cf-cors-relay.mts`) and set PUBLIC_HOBO_STATION_BROKER_URL / ?stationBroker=. Blob URLs are not Cloudflare.";

export async function provisionCloudflareStationViaBroker(input: {
	readonly stationId: string;
	readonly baseUrl?: string;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly fetchImpl?: typeof fetch;
}): Promise<TemporaryStationProvision> {
	const base = (
		input.baseUrl ??
		resolveStationBrokerBase({
			pageUrl: input.pageUrl,
			basePath: input.basePath,
		})
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
			`${RELAY_REMEDIATION} (${error instanceof Error ? error.message : String(error)})`,
		);
	}

	const body: JsonValue = await response.json();
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		const fail = isJsonObject(body) ? body : {};
		throw new Error(
			(isJsonString(fail.remediation) ? fail.remediation : undefined) ??
				(isJsonString(fail.error) ? fail.error : undefined) ??
				`Cloudflare Temporary Accounts HTTP ${response.status} at ${base}. ${RELAY_REMEDIATION}`,
		);
	}

	if ("apiToken" in body || "api_token" in body || "TEMP_API_TOKEN" in body) {
		throw new Error(
			"Temporary Accounts broker leaked apiToken to the browser — refusing response",
		);
	}
	if (!isJsonString(body.stationUrl) || !isWorkersDevStationUrl(body.stationUrl)) {
		throw new Error(
			`Broker returned non-workers.dev stationUrl (${String(body.stationUrl)}). Refusing blob/offline stubs as Cloudflare.`,
		);
	}
	if (!isJsonString(body.claimUrl) || body.claimUrl.length === 0) {
		throw new Error("Broker response missing claimUrl");
	}
	if (
		!isJsonString(body.stationId) ||
		!isJsonString(body.scriptName) ||
		!isJsonString(body.expiresAt)
	) {
		throw new Error("Broker response missing station fields");
	}
	return {
		ok: true,
		stationId: body.stationId,
		scriptName: body.scriptName,
		stationUrl: body.stationUrl,
		claimUrl: body.claimUrl,
		expiresAt: body.expiresAt,
		anonymous: true,
		temporary: true,
	};
}
