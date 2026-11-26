import {
	asPageUrl,
	currentLocationHref,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json-inspect.js";

/** Same-origin OpenSaaS Temporary Accounts ship for Examples console. */

export type OpenSaasTemporaryShipResult = {
	readonly exampleId: string;
	readonly stationId: string;
	readonly clientUrl: string;
	readonly serverUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly databaseMode: "neon-claimable";
	readonly databaseClaimUrl: string;
	readonly databaseMocked: boolean;
	readonly serverMode:
		| "openpouch-anon"
		| "clawdship-anon"
		| "cloudflare-temp-neon";
	readonly serverMocked: boolean;
};

function sameOriginCfTempBase(pageUrl?: string | URL, basePath = "/HoBo/"): string {
	const href = currentLocationHref();
	const page = pageUrl
		? asPageUrl(pageUrl)
		: href
			? new URL(href)
			: null;
	if (!page) {
		throw new Error(
			"OpenSaaS Cloudflare Temporary Accounts ship needs a page URL (astro dev).",
		);
	}
	const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
	const prefix = base.length === 0 || base === "/" ? "" : base;
	return `${page.origin}${prefix}/api/cf-temp`;
}

/**
 * Ship real Open SaaS via Temporary Accounts.
 * `root` is the Bindle waspApp(root) path — server builds that tree.
 * Bindle `db` is realized via Neon Claimable (anon, zero project keys).
 */
export async function shipOpenSaasViaTemporaryAccounts(input: {
	readonly stationId: string;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly fetchImpl?: typeof fetch;
	readonly root: string;
}): Promise<OpenSaasTemporaryShipResult> {
	const base = sameOriginCfTempBase(input.pageUrl, input.basePath);
	const fetchImpl = input.fetchImpl ?? fetch;
	if (!input.root.trim()) {
		throw new Error("Temporary Accounts ship requires Bindle waspApp(root)");
	}
	let response: Response;
	try {
		response = await fetchImpl(`${base}/opensaas`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				stationId: input.stationId,
				root: input.root,
			}),
			signal: AbortSignal.timeout(600_000),
		});
	} catch (error) {
		throw new Error(
			`OpenSaaS Temporary Accounts ship unreachable at ${base}/opensaas (${error instanceof Error ? error.message : String(error)}). Run pnpm --filter hobo-site run dev.`,
		);
	}
	const body: JsonValue = await response.json();
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		const fail = isJsonObject(body) ? body : {};
		throw new Error(
			(isJsonString(fail.remediation) ? fail.remediation : undefined) ??
				(isJsonString(fail.error) ? fail.error : undefined) ??
				`OpenSaaS Temporary Accounts HTTP ${response.status}`,
		);
	}
	if (!isJsonString(body.clientUrl) || !body.clientUrl.includes(".workers.dev")) {
		throw new Error(
			`OpenSaaS ship returned non-workers.dev clientUrl (${isJsonString(body.clientUrl) ? body.clientUrl : ""})`,
		);
	}
	if (
		!isJsonString(body.claimUrl) ||
		!isJsonString(body.serverUrl) ||
		!isJsonString(body.expiresAt)
	) {
		throw new Error("OpenSaaS Temporary Accounts response missing claimUrl/serverUrl");
	}
	if (body.databaseMode !== "neon-claimable" || !isJsonString(body.databaseClaimUrl)) {
		throw new Error(
			"OpenSaaS Temporary Accounts response missing Neon claimable db fields",
		);
	}
	if (
		body.serverMode !== "openpouch-anon" &&
		body.serverMode !== "clawdship-anon" &&
		body.serverMode !== "cloudflare-temp-neon"
	) {
		throw new Error(
			"OpenSaaS Temporary Accounts response missing anon server mode (openpouch-anon|clawdship-anon|cloudflare-temp-neon)",
		);
	}
	if (
		/127\.0\.0\.1|localhost/iu.test(body.serverUrl) ||
		body.serverUrl === body.clientUrl
	) {
		throw new Error(
			"OpenSaaS Temporary Accounts serverUrl must be a distinct public anon host",
		);
	}
	return {
		exampleId: isJsonString(body.exampleId) ? body.exampleId : "opensaas",
		stationId: input.stationId,
		clientUrl: body.clientUrl,
		serverUrl: body.serverUrl,
		claimUrl: body.claimUrl,
		expiresAt: body.expiresAt,
		anonymous: true,
		temporary: true,
		databaseMode: "neon-claimable",
		databaseClaimUrl: body.databaseClaimUrl,
		databaseMocked: body.databaseMocked === true,
		serverMode: body.serverMode,
		serverMocked: body.serverMocked === true,
	};
}
