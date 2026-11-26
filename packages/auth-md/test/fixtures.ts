/**
 * Offline fixtures. Every test in this package injects `fetchImpl` from here;
 * nothing touches the network, and no fixture holds real key material.
 */
import type { HttpPort } from "../src/http.js";
import type { SessionBindingInput } from "../src/index.js";
import { parseScopes, parseSessionBinding } from "../src/index.js";

export const RESOURCE = "https://api.example.test";
export const METADATA_URL = `${RESOURCE}/.well-known/oauth-protected-resource`;
export const AUTH_MD_URL = `${RESOURCE}/auth.md`;
export const REGISTRATION_URL = `${RESOURCE}/agent/register`;
export const CLAIM_URL = `${RESOURCE}/agent/claim`;
export const POLL_URL = `${RESOURCE}/agent/claim/poll`;
export const ISSUER = "https://auth.example.test/";

/** Test-only signing key for the fixture assertion verifier. */
export const FIXTURE_SIGNING_KEY = "fixture-signing-key";

export interface RouteResponse {
	readonly status?: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly json?: unknown;
	readonly text?: string;
}

export type RouteHandler =
	| RouteResponse
	| ((request: {
			readonly body: unknown;
			readonly call: number;
	  }) => RouteResponse);

export interface FetchFixture {
	readonly port: HttpPort;
	readonly calls: readonly { readonly key: string; readonly body: unknown }[];
}

export function createFetchFixture(
	routes: Readonly<Record<string, RouteHandler>>,
	options: {
		readonly maxResponseBytes?: number;
		readonly timeoutMs?: number;
	} = {},
): FetchFixture {
	const calls: { key: string; body: unknown }[] = [];
	const counts = new Map<string, number>();

	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		const key = `${method} ${url}`;
		const body =
			typeof init?.body === "string"
				? (JSON.parse(init.body) as unknown)
				: undefined;
		calls.push({ key, body });

		const handler = routes[key];
		if (handler === undefined) {
			return new Response(JSON.stringify({ error: "not_found" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		}
		const call = (counts.get(key) ?? 0) + 1;
		counts.set(key, call);
		const route =
			typeof handler === "function" ? handler({ body, call }) : handler;

		const payload =
			route.text ??
			(route.json === undefined ? null : JSON.stringify(route.json));
		const headers: Record<string, string> = {
			...(route.json === undefined
				? {}
				: { "content-type": "application/json" }),
			...(route.headers ?? {}),
		};
		const status = route.status ?? 200;
		return new Response(status === 204 || status >= 300 ? null : payload, {
			status,
			headers,
		});
	}) as typeof fetch;

	return {
		port: {
			fetchImpl,
			...(options.maxResponseBytes === undefined
				? {}
				: { maxResponseBytes: options.maxResponseBytes }),
			...(options.timeoutMs === undefined
				? {}
				: { timeoutMs: options.timeoutMs }),
		},
		calls,
	};
}

export function metadataBody(
	overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		resource: `${RESOURCE}/`,
		authorization_servers: [ISSUER],
		scopes_supported: ["repo:read", "issues:write"],
		bearer_methods_supported: ["header"],
		anonymous_registration_endpoint: REGISTRATION_URL,
		auth_md_url: AUTH_MD_URL,
		...overrides,
	};
}

/** Prose that deliberately disagrees with the metadata above. */
export const OVERCLAIMING_AUTH_MD = `# Agent access

This service supports anonymous agent registration.

Scopes available to agents:

- \`repo:read\`
- \`issues:write\`
- \`admin:all\`
`;

export const AGREEING_AUTH_MD = `# Agent access

This service supports anonymous agent registration.

- \`repo:read\`
- \`issues:write\`
`;

export const binding = (overrides: Partial<SessionBindingInput> = {}) =>
	parseSessionBinding({
		sessionId: "session-1",
		tenantId: "tenant-acme",
		projectId: "project-bo",
		audience: "https://api.example.test/",
		service: `${RESOURCE}/`,
		...overrides,
	});

export const scopes = (...values: readonly string[]) => parseScopes(values);

/** Obviously-fake key material: no real secret is ever committed here. */
export const FAKE_KEY_MATERIAL = "fixture-agent-key-not-a-real-credential";
export const FAKE_ROTATED_KEY_MATERIAL =
	"fixture-rotated-agent-key-not-a-real-credential";
export const FAKE_POLL_TOKEN = "fixture-poll-token-not-a-real-credential";
