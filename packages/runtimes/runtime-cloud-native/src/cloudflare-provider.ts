/**
 * REAL Cloudflare cloud-native provider (credential-gated, injected-fetch).
 *
 * Honesty rules (same pattern as `@hobo/hobo` cloudflare-client and the Convex
 * management client): the live path activates only when credentials are
 * present, requests are formed against an injected fetch so tests never need
 * the network, and a missing credential FAILS CLOSED with the exact missing
 * env-var names — never a silent pass. Env inspection is presence-only;
 * credential values are never logged or echoed.
 *
 * `servePrivate` realizes the FetchHandler mesh contract for a REMOTE
 * provider: one handler per private resource that PROXIES to the resource's
 * public endpoint when the serve context binds one, and otherwise answers 501
 * with a machine-readable remediation — an honest partial realization, never
 * a fake 200.
 */

import type {
	FetchHandler,
	PrivateServeResult,
	RuntimeEnsureContext,
	RuntimeEnsureResult,
	ServePrivateContext,
} from "@hobo/core";
import type { CloudNativeHostProvider } from "./host.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: env var carrying the Cloudflare API token (presence-only gate).
export const CLOUDFLARE_API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
// public-contract: env var carrying the Cloudflare account id (presence-only gate).
export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
//   GET https://api.cloudflare.com/client/v4/user/tokens/verify
//   Authorization: Bearer <token>
//   (docs: developers.cloudflare.com/api/operations/user-api-tokens-verify-token)
// public-contract: token verify endpoint driven through the injected fetch.
export const CLOUDFLARE_TOKEN_VERIFY_URL =
	"https://api.cloudflare.com/client/v4/user/tokens/verify";
// Binds a private resource to its deployed public endpoint via bindleEnv key
// `HOBO_CLOUD_NATIVE_ENDPOINT_<RESOURCE>` where <RESOURCE> is the resource
// name uppercased with non-alphanumerics as `_`.
// public-contract: bindleEnv key prefix consumers set to bind endpoints.
export const CLOUDFLARE_ENDPOINT_BINDLE_ENV_PREFIX =
	"HOBO_CLOUD_NATIVE_ENDPOINT_";
// Returned (HTTP 501) by a remote handler with no bound public endpoint yet.
// public-contract: machine-readable unbound-handler error code.
export const CLOUDFLARE_REMOTE_HANDLER_UNBOUND =
	"cloudflare-remote-handler-unbound";

/**
 * Typed failure for the Cloudflare cloud-native provider. Always carries
 * remediation text so callers can act without reverse-engineering the API.
 */
export class CloudflareCloudNativeError extends Error {
	readonly remediation: string;

	constructor(message: string, remediation: string) {
		super(`${message} — ${remediation}`);
		this.name = "CloudflareCloudNativeError";
		this.remediation = remediation;
	}
}

export interface CloudflareCloudNativeProviderOptions {
	/** Cloudflare account id; absence gates the provider closed. */
	readonly accountId?: string | undefined;
	/** Cloudflare API token; absence gates the provider closed. */
	readonly apiToken?: string | undefined;
	/** Transport. Defaults to the global fetch; injected in tests. */
	readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Parse-don't-validate the token verify payload: an untrusted API response
 * becomes the parsed token status or throws — nothing downstream re-checks
 * broad DTOs. Accepts only `{ success: true, result: { status: "active" } }`.
 */
function parseTokenVerifyPayload(payload: JsonValue): string {
	const remediation =
		`Re-check the token at ${CLOUDFLARE_TOKEN_VERIFY_URL} (dash.cloudflare.com → ` +
		"My Profile → API Tokens) and supply an active token via " +
		`${CLOUDFLARE_API_TOKEN_ENV}.`;
	if (!isJsonObject(payload) || payload === null) {
		throw new CloudflareCloudNativeError(
			"cloudflare token verify returned a malformed payload (not an object)",
			remediation,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const record = payload as JsonObject;
	if (record.success !== true) {
		throw new CloudflareCloudNativeError(
			"cloudflare token verify reported success=false",
			remediation,
		);
	}
	const result = record.result;
	if (!isJsonObject(result) || result === null) {
		throw new CloudflareCloudNativeError(
			"cloudflare token verify payload is missing result",
			remediation,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const status = (result as JsonObject).status;
	if (!isJsonString(status)) {
		throw new CloudflareCloudNativeError(
			"cloudflare token verify payload is missing result.status",
			remediation,
		);
	}
	if (status !== "active") {
		throw new CloudflareCloudNativeError(
			`cloudflare API token is not active (status: ${status})`,
			remediation,
		);
	}
	return status;
}

function endpointBindleKey(resourceName: string): string {
	return `${CLOUDFLARE_ENDPOINT_BINDLE_ENV_PREFIX}${resourceName
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")}`;
}

/** Parse-don't-validate the bound endpoint: must be an http(s) URL. */
function parseEndpoint(resourceName: string, key: string, value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new CloudflareCloudNativeError(
			`cloudflare remote endpoint for '${resourceName}' (${key}) is not a URL`,
			"Bind the key to the resource's deployed https endpoint (e.g. the workers.dev URL from `hobo up`).",
		);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new CloudflareCloudNativeError(
			`cloudflare remote endpoint for '${resourceName}' (${key}) must be http(s), got ${url.protocol}`,
			"Bind the key to the resource's deployed https endpoint (e.g. the workers.dev URL from `hobo up`).",
		);
	}
	return url;
}

function proxyHandler(endpoint: URL, fetchImpl: typeof fetch): FetchHandler {
	return async (request: Request): Promise<Response> => {
		const incoming = new URL(request.url);
		// The remote endpoint is the origin; the incoming path + query carry over.
		const target = new URL(incoming.pathname + incoming.search, endpoint);
		const init: RequestInit = {
			method: request.method,
			headers: request.headers,
		};
		if (request.method !== "GET" && request.method !== "HEAD") {
			init.body = await request.arrayBuffer();
		}
		const upstream = await fetchImpl(target, init);
		// Relay status + headers + body verbatim — the proxy adds nothing.
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers,
		});
	};
}

function unboundHandler(resourceName: string): FetchHandler {
	const key = endpointBindleKey(resourceName);
	return async () =>
		Response.json(
			{
				error: CLOUDFLARE_REMOTE_HANDLER_UNBOUND,
				resource: resourceName,
				remediation:
					`No public endpoint bound for '${resourceName}'. Deploy the Worker ` +
					`first (hobo up), then bind bindleEnv['${key}'] to its public URL.`,
			},
			{ status: 501 },
		);
}

/**
 * Create the REAL Cloudflare cloud-native provider. No network call happens at
 * construction; the token verify request is formed and sent only on `ensure`
 * and only when both credentials are present.
 */
export function createCloudflareCloudNativeProvider(
	options: CloudflareCloudNativeProviderOptions = {},
): CloudNativeHostProvider {
	const accountId = options.accountId?.trim();
	const apiToken = options.apiToken?.trim();
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	return {
		id: "cloudflare",
		async ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult> {
			// Presence-only credential check — values are never logged or echoed.
			const missing: string[] = [];
			if (!apiToken) missing.push(CLOUDFLARE_API_TOKEN_ENV);
			if (!accountId) missing.push(CLOUDFLARE_ACCOUNT_ID_ENV);
			if (missing.length > 0) {
				const note = `cloud-native provider 'cloudflare' is credential-gated: missing ${missing.join(", ")}`;
				ctx.emitProgress?.(`hobo: ${note}`);
				return {
					kind: "cloud-native",
					ready: false,
					notes: [note],
					details: {
						provider: "cloudflare",
						implemented: true,
						credentialGated: true,
						missing,
					},
				};
			}
			const response = await fetchImpl(CLOUDFLARE_TOKEN_VERIFY_URL, {
				method: "GET",
				headers: { authorization: `Bearer ${apiToken}` },
			});
			if (!response.ok) {
				throw new CloudflareCloudNativeError(
					`cloudflare token verify failed (HTTP ${response.status})`,
					`Check that ${CLOUDFLARE_API_TOKEN_ENV} is a valid API token with ` +
						"Workers permissions (dash.cloudflare.com → My Profile → API Tokens).",
				);
			}
			const tokenStatus = parseTokenVerifyPayload(await response.json());
			ctx.emitProgress?.(
				"hobo: cloud-native cloudflare provider ready (token verified)",
			);
			return {
				kind: "cloud-native",
				ready: true,
				notes: [
					`cloud-native provider 'cloudflare' ready (token status: ${tokenStatus})`,
				],
				details: { provider: "cloudflare", implemented: true, tokenStatus },
			};
		},
		async servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult> {
			const handlers = new Map<string, FetchHandler>();
			for (const component of ctx.privateComponents) {
				const key = endpointBindleKey(component.resourceName);
				const bound = ctx.bindleEnv?.[key];
				handlers.set(
					component.resourceName,
					bound === undefined
						? unboundHandler(component.resourceName)
						: proxyHandler(
								parseEndpoint(component.resourceName, key, bound),
								fetchImpl,
							),
				);
			}
			return {
				kind: "cloud-native",
				handlers,
				isolation: {
					isolateBoundary: "cloudflare-worker",
					// Remote-proxy mode: no local sandboxes exist on this side.
					privateSandboxes: 0,
					details: { mode: "remote-proxy" },
				},
				close: async () => {
					handlers.clear();
				},
			};
		},
	};
}
