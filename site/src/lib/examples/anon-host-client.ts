import {
	asPageUrl,
	currentLocationHref,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json-inspect.js";

/**
 * Same-origin agent anonymous host client for providers without Temporary Accounts.
 * Never uses blob: URLs.
 */

/** Legacy type kept for OpenSaaS same-origin helper signatures (unused OOB). */
export type AnonProviderId = string;

/** Empty — Railway dropped from OOB; Vercel uses Drop (`/api/vercel-temp`). */
export const ANON_SAME_ORIGIN_PROVIDERS: ReadonlySet<string> = new Set();

export type AnonStationProvision = {
	readonly ok: true;
	readonly stationId: string;
	readonly stationUrl: string;
	readonly endpointUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly hostKind: "same-origin-agent";
	readonly providerId: string;
};

export type AnonOpenSaasShip = {
	readonly ok: true;
	readonly exampleId: string;
	readonly clientUrl: string;
	readonly serverUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly hostKind: "same-origin-agent";
	readonly providerId: string;
};

export type AnonHostError = {
	readonly ok: false;
	readonly error: string;
	readonly remediation?: string;
};

function sameOriginAnonApiBase(
	pageUrl: string | URL,
	basePath = "/HoBo/",
): string {
	const page = asPageUrl(pageUrl);
	const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
	const prefix = base.length === 0 || base === "/" ? "" : base;
	return `${page.origin}${prefix}/api/anon`;
}

export function isAnonSameOriginProvider(id: string): id is AnonProviderId {
	return ANON_SAME_ORIGIN_PROVIDERS.has(id);
}

export function isHttpStationUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export function isBlobUrl(url: string): boolean {
	return url.startsWith("blob:");
}

const REMEDIATION =
	"Same-origin anon host unreachable. Local: `pnpm --filter hobo-site run dev` (serves /api/anon). Blob URLs are not remote providers.";

export async function provisionAnonStationViaSameOrigin(input: {
	readonly providerId: AnonProviderId;
	readonly stationId: string;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly fetchImpl?: typeof fetch;
}): Promise<AnonStationProvision> {
	const pageUrl = input.pageUrl ?? currentLocationHref();
	if (!pageUrl) {
		throw new Error(
			"Anon same-origin station needs a page URL (astro dev).",
		);
	}
	const base = sameOriginAnonApiBase(pageUrl, input.basePath ?? "/HoBo/");
	const fetchImpl = input.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(`${base}/${input.providerId}/station`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ stationId: input.stationId }),
			signal: AbortSignal.timeout(60_000),
		});
	} catch (error) {
		throw new Error(
			`${REMEDIATION} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const body: JsonValue = await response.json();
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		const fail = isJsonObject(body) ? body : {};
		throw new Error(
			(isJsonString(fail.remediation) ? fail.remediation : undefined) ??
				(isJsonString(fail.error) ? fail.error : undefined) ??
				`Anon host HTTP ${response.status} at ${base}/${input.providerId}/station`,
		);
	}
	const url =
		(isJsonString(body.stationUrl) ? body.stationUrl : "") ||
		(isJsonString(body.endpointUrl) ? body.endpointUrl : "");
	if (isBlobUrl(url)) {
		throw new Error(
			`Anon host returned blob: URL for ${input.providerId} — refusing`,
		);
	}
	if (!isHttpStationUrl(url)) {
		throw new Error(
			`Anon host returned non-HTTP stationUrl (${url}) for ${input.providerId}`,
		);
	}
	if (!isJsonString(body.claimUrl) || !isJsonString(body.stationId) || !isJsonString(body.expiresAt)) {
		throw new Error("Anon host response missing claimUrl");
	}
	return {
		ok: true,
		stationId: body.stationId,
		stationUrl: url,
		endpointUrl: url,
		claimUrl: body.claimUrl,
		expiresAt: body.expiresAt,
		anonymous: true,
		temporary: true,
		hostKind: "same-origin-agent",
		providerId: input.providerId,
	};
}

export async function shipOpenSaasViaSameOriginAnon(input: {
	readonly providerId: AnonProviderId;
	readonly stationId: string;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly fetchImpl?: typeof fetch;
}): Promise<AnonOpenSaasShip> {
	const pageUrl = input.pageUrl ?? currentLocationHref();
	if (!pageUrl) {
		throw new Error("OpenSaaS same-origin ship needs a page URL (astro dev).");
	}
	const base = sameOriginAnonApiBase(pageUrl, input.basePath ?? "/HoBo/");
	const fetchImpl = input.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(`${base}/${input.providerId}/opensaas`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ stationId: input.stationId }),
			signal: AbortSignal.timeout(180_000),
		});
	} catch (error) {
		throw new Error(
			`OpenSaaS same-origin ship unreachable at ${base}/${input.providerId}/opensaas (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	const body: JsonValue = await response.json();
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		const fail = isJsonObject(body) ? body : {};
		throw new Error(
			(isJsonString(fail.remediation) ? fail.remediation : undefined) ??
				(isJsonString(fail.error) ? fail.error : undefined) ??
				`OpenSaaS same-origin HTTP ${response.status}`,
		);
	}
	if (!isJsonString(body.clientUrl) || isBlobUrl(body.clientUrl)) {
		throw new Error(
			`OpenSaaS same-origin returned blob: clientUrl for ${input.providerId}`,
		);
	}
	if (!isHttpStationUrl(body.clientUrl)) {
		throw new Error(
			`OpenSaaS same-origin returned non-HTTP clientUrl (${body.clientUrl})`,
		);
	}
	if (
		!isJsonString(body.claimUrl) ||
		!isJsonString(body.serverUrl) ||
		!isJsonString(body.expiresAt) ||
		!isJsonString(body.exampleId)
	) {
		throw new Error("OpenSaaS same-origin response missing claimUrl/serverUrl");
	}
	return {
		ok: true,
		exampleId: body.exampleId,
		clientUrl: body.clientUrl,
		serverUrl: body.serverUrl,
		claimUrl: body.claimUrl,
		expiresAt: body.expiresAt,
		anonymous: true,
		temporary: true,
		hostKind: "same-origin-agent",
		providerId: input.providerId,
	};
}
