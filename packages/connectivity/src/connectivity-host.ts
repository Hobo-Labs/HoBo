/**
 * In-process HTTP-shaped façade for the ConnectivityHost integration boundary.
 * Used by PACT consumer/provider tests (structurally compatible with
 * `@hobo/contract-harness` ProviderStub — no production harness dependency).
 */

import {
	createMeteringBus,
	getNamedEndpoint,
	type PolicyRequest,
	parseTenantId,
} from "@hobo/core";
import { createMemoryDnsProvider } from "./dns/memory-provider.js";
import { createPublicDnsManager } from "./dns/public-dns-manager.js";
import { isJsonString, type JsonObject } from "./json.js";
import { createInMemoryMeteringSink } from "./metering/sinks.js";
import { createOpaPolicyEngine } from "./policy/opa-engine.js";
import { HOBO_DEFAULT_POLICY_DOCUMENT } from "./policy/rego-lite.js";
import { createTagAclPolicyEngine } from "./policy/tag-acl-engine.js";

// public-contract: provider name for ConnectivityHost PACT documents.
export const CONNECTIVITY_HOST_PROVIDER_NAME = "ConnectivityHost" as const;

export interface ConnectivityHostRequest {
	readonly method: string;
	readonly path: string;
	readonly body?: unknown;
}

export interface ConnectivityHostResponse {
	readonly status: number;
	readonly body?: unknown;
}

export interface ConnectivityHostHandler {
	readonly name: typeof CONNECTIVITY_HOST_PROVIDER_NAME;
	handle(
		request: ConnectivityHostRequest,
	): ConnectivityHostResponse | Promise<ConnectivityHostResponse>;
}

/**
 * Real package surface behind an HTTP-shaped boundary for contract capture.
 */
export function createConnectivityHostHandler(): ConnectivityHostHandler {
	const sink = createInMemoryMeteringSink("connectivity-host");
	const bus = createMeteringBus([sink]);
	const tagEngine = createTagAclPolicyEngine({ metering: bus });
	const opaEngine = createOpaPolicyEngine({
		policyDocument: HOBO_DEFAULT_POLICY_DOCUMENT,
		metering: bus,
	});
	const memoryDns = createMemoryDnsProvider();
	const dns = createPublicDnsManager({
		config: {
			managedBy: "hobo",
			provider: "memory",
			zone: "example.com",
			allowedGatewaySuffixes: [".ts.net", ".cfargotunnel.com"],
		},
		provider: memoryDns,
		metering: bus,
	});

	return {
		name: CONNECTIVITY_HOST_PROVIDER_NAME,
		async handle(request) {
			if (
				request.method === "GET" &&
				request.path.startsWith("/named-endpoints/")
			) {
				return handleNamedEndpoint(request);
			}
			if (request.method === "POST" && request.path === "/policy/evaluate") {
				return handlePolicy(request, tagEngine, opaEngine);
			}
			if (request.method === "POST" && request.path === "/dns/reconcile") {
				return handleDnsReconcile(request, dns);
			}
			if (request.method === "POST" && request.path === "/dns/suggest") {
				return handleDnsSuggest(request, dns);
			}
			if (request.method === "GET" && request.path === "/metering/events") {
				return {
					status: 200,
					body: {
						count: sink.events.length,
						eventTypes: sink.events.map((e) => e.eventType),
					},
				};
			}
			return {
				status: 404,
				body: { error: { code: "UNKNOWN_PATH", path: request.path } },
			};
		},
	};
}

function handleNamedEndpoint(
	request: ConnectivityHostRequest,
): ConnectivityHostResponse {
	const url = new URL(request.path, "http://connectivity.local");
	const mode = url.pathname.endsWith("/overlay") ? "overlay" : "local";
	const resource = url.searchParams.get("resource") ?? "web";
	const app = url.searchParams.get("app") ?? "myapp";
	const env = url.searchParams.get("env") ?? undefined;
	const tenant = url.searchParams.get("tenant") ?? undefined;
	const branch = url.searchParams.get("branch") ?? undefined;
	try {
		const named = getNamedEndpoint({
			resource,
			app,
			mode,
			...(env !== undefined ? { env } : undefined),
			...(tenant !== undefined ? { tenant } : undefined),
			...(branch !== undefined ? { branch } : undefined),
		});
		return {
			status: 200,
			body: {
				url: named,
				hostname: named.replace(/^https?:\/\//, ""),
				mode,
			},
		};
	} catch (error) {
		return {
			status: 400,
			body: {
				error: {
					code: "NAMED_ENDPOINT_INVALID",
					message: error instanceof Error ? error.message : String(error),
				},
			},
		};
	}
}

async function handlePolicy(
	request: ConnectivityHostRequest,
	tagEngine: ReturnType<typeof createTagAclPolicyEngine>,
	opaEngine: ReturnType<typeof createOpaPolicyEngine>,
): Promise<ConnectivityHostResponse> {
	// SAFETY: assertion required at this I/O or test boundary.
	const body = (request.body ?? {}) as JsonObject;
	const engineKind = body.engine === "opa" ? "opa" : "tag-acl";
	const subjectTenant = String(body.subjectTenant ?? "local");
	const resourceTenant = String(body.resourceTenant ?? subjectTenant);
	const action = String(body.action ?? "read");
	const tags = Array.isArray(body.subjectTags)
		? body.subjectTags.filter((t): t is string => isJsonString(t))
		: [];
	const resourceTags = Array.isArray(body.resourceTags)
		? body.resourceTags.filter((t): t is string => isJsonString(t))
		: [];
	// Env isolation: ensure both sides carry env: tags (default development for
	// same-tenant contract paths when omitted).
	const subjectEnv =
		tags.find((t) => t.startsWith("env:")) ?? "env:development";
	const resourceEnv =
		resourceTags.find((t) => t.startsWith("env:")) ?? subjectEnv;
	const subjectTags = tags.some((t) => t.startsWith("env:"))
		? tags
		: [...tags, subjectEnv];
	const resTags = resourceTags.some((t) => t.startsWith("env:"))
		? resourceTags
		: [...resourceTags, resourceEnv];
	const req: PolicyRequest = {
		subject: {
			identity: String(body.subjectIdentity ?? "pact-subject"),
			tenantId: parseTenantId(subjectTenant),
			tags: subjectTags,
		},
		action,
		resource: {
			kind: String(body.resourceKind ?? "resource"),
			id: String(body.resourceId ?? "1"),
			tenantId: parseTenantId(resourceTenant),
			tags: resTags,
			...(body.resourceShared === true
				? { attributes: { shared: "true" } }
				: undefined),
		},
	};
	const decision =
		engineKind === "opa"
			? await opaEngine.evaluate(req)
			: await tagEngine.evaluate(req);
	return {
		status: 200,
		body: {
			effect: decision.effect,
			engineId: decision.engineId,
			reasons: decision.reasons,
		},
	};
}

async function handleDnsReconcile(
	request: ConnectivityHostRequest,
	dns: ReturnType<typeof createPublicDnsManager>,
): Promise<ConnectivityHostResponse> {
	// SAFETY: assertion required at this I/O or test boundary.
	const body = (request.body ?? {}) as JsonObject;
	try {
		const result = await dns.reconcileEntrypoint({
			tenantId: parseTenantId(String(body.tenantId ?? "acme")),
			hostname: String(body.hostname ?? "web.myapp.hobo.example.com"),
			gatewayHostname: String(body.gatewayHostname ?? "funnel.ts.net"),
		});
		return {
			status: 200,
			body: { applied: result.applied, suggested: result.suggested },
		};
	} catch (error) {
		return {
			status: 400,
			body: {
				error: {
					code: "DNS_RECONCILE_FAILED",
					message: error instanceof Error ? error.message : String(error),
				},
			},
		};
	}
}

async function handleDnsSuggest(
	request: ConnectivityHostRequest,
	dns: ReturnType<typeof createPublicDnsManager>,
): Promise<ConnectivityHostResponse> {
	// SAFETY: assertion required at this I/O or test boundary.
	const body = (request.body ?? {}) as JsonObject;
	try {
		const suggested = await dns.suggestEntrypoint({
			tenantId: parseTenantId(String(body.tenantId ?? "acme")),
			hostname: String(body.hostname ?? "web.myapp.hobo.example.com"),
			gatewayHostname: String(body.gatewayHostname ?? "funnel.ts.net"),
		});
		return { status: 200, body: { suggested } };
	} catch (error) {
		return {
			status: 400,
			body: {
				error: {
					code: "DNS_SUGGEST_FAILED",
					message: error instanceof Error ? error.message : String(error),
				},
			},
		};
	}
}
