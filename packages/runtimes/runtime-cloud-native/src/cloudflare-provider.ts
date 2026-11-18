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

export const CLOUDFLARE_API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
export const CLOUDFLARE_TOKEN_VERIFY_URL =
	"https://api.cloudflare.com/client/v4/user/tokens/verify";
export const CLOUDFLARE_ENDPOINT_BINDLE_ENV_PREFIX =
	"HOBO_CLOUD_NATIVE_ENDPOINT_";
export const CLOUDFLARE_REMOTE_HANDLER_UNBOUND =
	"cloudflare-remote-handler-unbound";

export class CloudflareCloudNativeError extends Error {
	readonly remediation: string;

	constructor(message: string, remediation: string) {
		super(`${message} — ${remediation}`);
		this.name = "CloudflareCloudNativeError";
		this.remediation = remediation;
	}
}

export interface CloudflareCloudNativeProviderOptions {
	readonly accountId?: string | undefined;
	readonly apiToken?: string | undefined;
	readonly fetchImpl?: typeof fetch | undefined;
}

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
		const target = new URL(endpoint);
		target.pathname = incoming.pathname;
		target.search = incoming.search;
		target.hash = "";
		const init: RequestInit = {
			method: request.method,
			headers: request.headers,
			redirect: "manual",
		};
		if (request.method !== "GET" && request.method !== "HEAD") {
			init.body = await request.arrayBuffer();
		}
		const upstream = await fetchImpl(target, init);
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

export function createCloudflareCloudNativeProvider(
	options: CloudflareCloudNativeProviderOptions = {},
): CloudNativeHostProvider {
	const accountId = options.accountId?.trim();
	const apiToken = options.apiToken?.trim();
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	return {
		id: "cloudflare",
		async ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult> {
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
