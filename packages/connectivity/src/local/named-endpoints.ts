import {
	type BindingResolverPort,
	createUsageEvent,
	getNamedEndpoint,
	getNamedEndpointHost,
	LOCAL_DEFAULT_TENANT_ID,
	type MeteringBus,
	type NamedEndpointParams,
	parseResourceId,
	type ResourceId,
	type TenantContext,
	tenantContextFromEnv,
} from "@hobo/core";

import { assertLocalNamedEndpointBackend } from "../env-isolation/local-airgap.js";

import {
	type PortlessProbe,
	probePortless,
	registerPortlessRoute,
} from "./portless.js";

export interface NamedEndpointEntry {
	readonly resourceName: string;
	readonly hostname: string;
	readonly url: string;
	readonly backendUrl: string;
	readonly mode: "local" | "overlay";
	readonly external: boolean;
	readonly serviceDiscoveryKey: string;
}

export interface NamedEndpointsResult {
	readonly namedEndpoints: readonly NamedEndpointEntry[];
	readonly primaryNamedUrl: string | null;
	readonly portless: PortlessProbe;
	readonly tenant: TenantContext;
	readonly serviceDiscovery: Readonly<Record<string, string>>;
	/** Prefer named URL when present, else backend. */
	readonly resolvePreferredUrl: (resourceName: string) => string | undefined;
	readonly close: () => Promise<void>;
}

export interface NamedEndpointInput {
	readonly resourceName: string;
	readonly kind: string;
	readonly backendUrl: string;
	readonly external: boolean;
	readonly serviceDiscoveryKey: string;
}

const sessionStore = new Map<string, NamedEndpointsResult>();

/** In-process session registry for MCP / inspect discovery. */
export function getNamedEndpointSession(
	sessionId = "default",
): NamedEndpointsResult | null {
	return sessionStore.get(sessionId) ?? null;
}

export function listNamedEndpointSessions(): readonly {
	readonly sessionId: string;
	readonly primaryNamedUrl: string | null;
	readonly count: number;
}[] {
	return [...sessionStore.entries()].map(([sessionId, value]) => ({
		sessionId,
		primaryNamedUrl: value.primaryNamedUrl,
		count: value.namedEndpoints.length,
	}));
}

/**
 * Build hierarchical named endpoints for a local serve result.
 * Portless is optional; without it we still emit hierarchical localhost names
 * (browsers resolve *.localhost → 127.0.0.1) and keep backend port URLs as source of truth.
 */
export async function attachNamedEndpoints(options: {
	readonly app: string;
	readonly endpoints: readonly NamedEndpointInput[];
	readonly tenant?: TenantContext;
	readonly env?: string;
	readonly branch?: string;
	readonly project?: string;
	readonly mode?: "local" | "overlay";
	readonly sessionId?: string;
	readonly metering?: MeteringBus;
	readonly processEnv?: NodeJS.ProcessEnv;
	readonly emitProgress?: (message: string) => void;
	readonly forcePortless?: PortlessProbe;
}): Promise<NamedEndpointsResult> {
	const processEnv = options.processEnv ?? process.env;
	const tenant = options.tenant ?? tenantContextFromEnv(processEnv);
	const mode = options.mode ?? "local";
	const portless = options.forcePortless ?? probePortless({ env: processEnv });
	const emit = options.emitProgress ?? (() => {});

	if (portless.hint) {
		emit(`hobo named-endpoints: ${portless.hint}`);
	}

	const namedEndpoints: NamedEndpointEntry[] = [];
	const serviceDiscovery: Record<string, string> = {};

	for (const endpoint of options.endpoints) {
		// Private mesh endpoints keep mesh URLs; still publish hierarchical overlay names for discovery.
		const endpointMode: "local" | "overlay" = endpoint.external
			? mode
			: "overlay";

		// Local-dev air-gap: never bind local mode to remote/prod backends.
		if (endpointMode === "local") {
			const airgap = assertLocalNamedEndpointBackend({
				mode: "local",
				backendUrl: endpoint.backendUrl,
				resourceEnv: options.env ?? tenant.env ?? "local-dev",
			});
			if (!airgap.ok) {
				throw new Error(`local-dev air-gap: ${airgap.reason}`);
			}
		}

		// Omit default single-tenant "local" slug so pure-local names stay clean
		// (web.myapp.local.hobo.localhost). Multi-tenant always includes tenant.
		const includeTenant = tenant.tenantId !== LOCAL_DEFAULT_TENANT_ID;
		const params: NamedEndpointParams = {
			resource: endpoint.resourceName,
			app: options.app,
			mode: endpointMode,
			...(includeTenant ? { tenant: tenant.tenantId } : undefined),
			...(options.env !== undefined
				? { env: options.env }
				: tenant.env !== undefined
					? { env: tenant.env }
					: endpointMode === "local"
						? { env: "local" }
						: undefined),
			...(options.branch !== undefined
				? { branch: options.branch }
				: tenant.branch !== undefined
					? { branch: tenant.branch }
					: undefined),
			...(options.project !== undefined
				? { project: options.project }
				: tenant.projectId !== undefined
					? { project: tenant.projectId }
					: undefined),
		};

		const hostname = getNamedEndpointHost(params);
		// Portless terminates TLS on :443 as https://hostname.
		// Without it, local external names ride the real loopback port as
		// http — https://hostname (implied :443) has nothing listening.
		const usePortlessHttps =
			endpoint.external && portless.enabled && Boolean(portless.binPath);
		const backendPort = listenPortOf(endpoint.backendUrl);
		const url = !endpoint.external
			? getNamedEndpoint({ ...params, scheme: "https" })
			: usePortlessHttps
				? getNamedEndpoint({ ...params, scheme: "https" })
				: getNamedEndpoint({
						...params,
						scheme: "http",
						...(backendPort !== undefined ? { port: backendPort } : undefined),
					});

		const backendUrl = endpoint.backendUrl;
		if (endpoint.external && portless.enabled && portless.binPath) {
			const reg = await registerPortlessRoute({
				hostname,
				backendUrl: endpoint.backendUrl,
				binPath: portless.binPath,
			});
			if (reg.registered) {
				emit(
					`hobo named-endpoints: portless ${hostname} → ${endpoint.backendUrl}`,
				);
			} else if (reg.note) {
				emit(`hobo named-endpoints: ${reg.note}`);
			}
		}

		const entry: NamedEndpointEntry = {
			resourceName: endpoint.resourceName,
			hostname,
			url,
			backendUrl,
			mode: endpointMode,
			external: endpoint.external,
			serviceDiscoveryKey: endpoint.serviceDiscoveryKey,
		};
		namedEndpoints.push(entry);

		// Prefer named URL in discovery when external + portless, else keep backend
		// but also publish hierarchical name under a companion key.
		const preferred =
			endpoint.external && portless.enabled ? url : endpoint.backendUrl;
		serviceDiscovery[endpoint.serviceDiscoveryKey] = preferred;
		serviceDiscovery[`${endpoint.serviceDiscoveryKey}__named`] = url;
		processEnv[endpoint.serviceDiscoveryKey] = preferred;
		processEnv[`${endpoint.serviceDiscoveryKey}__named`] = url;
		processEnv[`HOBO_NAMED_${endpoint.resourceName.toUpperCase()}_URL`] = url;

		await options.metering?.emit(
			createUsageEvent({
				tenantId: tenant.tenantId,
				eventType: "named_endpoint.register",
				resource: endpoint.resourceName,
				metadata: {
					hostname,
					url,
					external: endpoint.external,
					portless: portless.enabled,
				},
			}),
		);
	}

	const primary =
		namedEndpoints.find((e) => e.external) ?? namedEndpoints[0] ?? null;

	const result: NamedEndpointsResult = {
		namedEndpoints,
		primaryNamedUrl: primary?.url ?? null,
		portless,
		tenant,
		serviceDiscovery,
		resolvePreferredUrl(resourceName) {
			const hit = namedEndpoints.find((e) => e.resourceName === resourceName);
			if (!hit) return undefined;
			if (hit.external && portless.enabled) return hit.url;
			return hit.backendUrl;
		},
		async close() {
			for (const entry of namedEndpoints) {
				const envKey = entry.serviceDiscoveryKey;
				const namedKey = `${envKey}__named`;
				if (processEnv[envKey] === serviceDiscovery[envKey]) {
					delete processEnv[envKey];
				}
				if (processEnv[namedKey] === serviceDiscovery[namedKey]) {
					delete processEnv[namedKey];
				}
				const hoboKey = `HOBO_NAMED_${entry.resourceName.toUpperCase()}_URL`;
				if (processEnv[hoboKey] === entry.url) {
					delete processEnv[hoboKey];
				}
				await options.metering?.emit(
					createUsageEvent({
						tenantId: tenant.tenantId,
						eventType: "named_endpoint.unregister",
						resource: entry.resourceName,
						metadata: { hostname: entry.hostname },
					}),
				);
			}
			sessionStore.delete(options.sessionId ?? "default");
		},
	};

	sessionStore.set(options.sessionId ?? "default", result);
	if (result.primaryNamedUrl) {
		emit(`hobo named-endpoints: primary ${result.primaryNamedUrl}`);
	}
	return result;
}

/** Binding resolver that prefers hierarchical named URLs when registered. */
export function createNamedPreferringBindingResolver(options: {
	readonly named: NamedEndpointsResult;
	readonly fallback?: BindingResolverPort;
}): BindingResolverPort {
	return {
		async resolve(resourceId: ResourceId, property: string) {
			const name = String(resourceId);
			if (property === "url" || property === "http" || property === "baseUrl") {
				const preferred = options.named.resolvePreferredUrl(name);
				if (preferred) {
					const entry = options.named.namedEndpoints.find(
						(e) => e.resourceName === name,
					);
					const useNamed =
						entry?.external === true && options.named.portless.enabled;
					return {
						value: preferred,
						source: useNamed ? "named" : "service-discovery",
					};
				}
			}
			if (options.fallback) {
				return options.fallback.resolve(resourceId, property);
			}
			throw new Error(`no binding for ${resourceId}.${property}`);
		},
	};
}

export function resourceId(name: string): ResourceId {
	return parseResourceId(name);
}

function listenPortOf(backendUrl: string): number | undefined {
	try {
		const parsed = new URL(backendUrl);
		if (parsed.port) {
			const port = Number(parsed.port);
			return Number.isInteger(port) && port > 0 ? port : undefined;
		}
		if (parsed.protocol === "https:") return 443;
		if (parsed.protocol === "http:") return 80;
		return undefined;
	} catch {
		return undefined;
	}
}
