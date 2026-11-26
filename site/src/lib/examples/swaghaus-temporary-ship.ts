import {
	asPageUrl,
	currentLocationHref,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json-inspect.js";

/** Same-origin Convex swaghaus Temporary Accounts ship for Examples console. */

export type SwaghausTemporaryShipResult = {
	readonly exampleId: string;
	readonly stationId: string;
	readonly clientUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly deploymentUrl: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly mocked: boolean;
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
			"Swaghaus Cloudflare Temporary Accounts ship needs a page URL (astro dev).",
		);
	}
	const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
	const prefix = base.length === 0 || base === "/" ? "" : base;
	return `${page.origin}${prefix}/api/cf-temp`;
}

/**
 * Ship real swaghaus via Temporary Accounts API.
 * `root` is the Bindle convexApp(root) path — server deploys that tree.
 */
export async function shipSwaghausViaTemporaryAccounts(input: {
	readonly stationId: string;
	readonly pageUrl?: string | URL;
	readonly basePath?: string;
	readonly fetchImpl?: typeof fetch;
	readonly root: string;
}): Promise<SwaghausTemporaryShipResult> {
	const base = sameOriginCfTempBase(input.pageUrl, input.basePath);
	const fetchImpl = input.fetchImpl ?? fetch;
	if (!input.root.trim()) {
		throw new Error("Temporary Accounts ship requires Bindle convexApp(root)");
	}
	let response: Response;
	try {
		response = await fetchImpl(`${base}/swaghaus`, {
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
			`Swaghaus Temporary Accounts ship unreachable at ${base}/swaghaus (${error instanceof Error ? error.message : String(error)}). Run pnpm --filter hobo-site run dev.`,
		);
	}
	const body: JsonValue = await response.json();
	if (!response.ok || !isJsonObject(body) || body.ok !== true) {
		const fail = isJsonObject(body) ? body : {};
		throw new Error(
			(isJsonString(fail.remediation) ? fail.remediation : undefined) ??
				(isJsonString(fail.error) ? fail.error : undefined) ??
				`Swaghaus Temporary Accounts HTTP ${response.status}`,
		);
	}
	if (
		!isJsonString(body.clientUrl) ||
		!isJsonString(body.claimUrl) ||
		!isJsonString(body.expiresAt)
	) {
		throw new Error("Swaghaus Temporary Accounts response missing URLs");
	}
	return {
		exampleId: isJsonString(body.exampleId) ? body.exampleId : "swaghaus",
		stationId: input.stationId,
		clientUrl: body.clientUrl,
		claimUrl: body.claimUrl,
		expiresAt: body.expiresAt,
		deploymentUrl: isJsonString(body.deploymentUrl) ? body.deploymentUrl : "",
		anonymous: true,
		temporary: true,
		mocked: body.mocked === true,
	};
}
