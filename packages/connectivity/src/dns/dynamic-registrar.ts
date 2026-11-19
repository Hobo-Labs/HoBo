import {
	createUsageEvent,
	getNamedEndpointHost,
	type MeteringBus,
	type OverlayNetwork,
	type PolicyEngine,
	type PublicDnsManager,
	parseTenantId,
	type TenantId,
} from "@hobo/core";
import { isJsonString } from "../json.js";

export interface DynamicDnsTarget {
	readonly resource: string;
	readonly app: string;
	readonly env?: string;
	readonly branch?: string;
	readonly project?: string;
	readonly backendUrl?: string;
	readonly gatewayHostname?: string;
}

export interface JunctionDynamicDnsRegistrar {
	setTargets(targets: readonly DynamicDnsTarget[]): void;
	onHeartbeat(): Promise<{
		readonly registered: number;
		readonly skipped: number;
		readonly notes: readonly string[];
	}>;
	gatewayFor(resource: string): string | null;
	readonly lastResults: readonly DynamicDnsRegistrationResult[];
}

export interface DynamicDnsRegistrationResult {
	readonly resource: string;
	readonly hostname: string;
	readonly gatewayHostname: string | null;
	readonly applied: boolean;
	readonly note?: string;
}

export function createJunctionDynamicDnsRegistrar(options: {
	readonly tenantId: TenantId | string;
	readonly dns: PublicDnsManager;
	readonly overlay?: OverlayNetwork;
	readonly policy?: PolicyEngine;
	readonly metering?: MeteringBus;
	readonly tld?: string;
	readonly emitProgress?: (message: string) => void;
}): JunctionDynamicDnsRegistrar {
	const tenantId = isJsonString(options.tenantId)
		? parseTenantId(options.tenantId)
		: options.tenantId;
	let targets: DynamicDnsTarget[] = [];
	const gateways = new Map<string, string>();
	let lastResults: DynamicDnsRegistrationResult[] = [];

	return {
		setTargets(next) {
			targets = [...next];
		},
		get lastResults() {
			return lastResults;
		},
		gatewayFor(resource) {
			return gateways.get(resource) ?? null;
		},
		async onHeartbeat() {
			const notes: string[] = [];
			const results: DynamicDnsRegistrationResult[] = [];
			let registered = 0;
			let skipped = 0;

			for (const target of targets) {
				const hostname = getNamedEndpointHost({
					resource: target.resource,
					app: target.app,
					mode: "overlay",
					tenant: tenantId,
					...(target.env !== undefined ? { env: target.env } : undefined),
					...(target.branch !== undefined
						? { branch: target.branch }
						: undefined),
					...(target.project !== undefined
						? { project: target.project }
						: undefined),
					...(options.tld !== undefined ? { tld: options.tld } : undefined),
				});

				if (options.policy) {
					const decision = await options.policy.evaluate({
						subject: {
							identity: `junction-dns:${target.resource}`,
							tenantId,
							tags: ["role:junction"],
						},
						action: "dns.dynamic_register",
						resource: {
							kind: "dns-endpoint",
							id: hostname,
							tenantId,
						},
					});
					if (decision.effect === "deny") {
						skipped += 1;
						results.push({
							resource: target.resource,
							hostname,
							gatewayHostname: null,
							applied: false,
							note: decision.reasons.join("; "),
						});
						continue;
					}
				}

				let gateway =
					target.gatewayHostname ?? gateways.get(target.resource) ?? null;

				if (!gateway && options.overlay?.publishFunnel && target.backendUrl) {
					const funnel = await options.overlay.publishFunnel({
						tenantId,
						backendUrl: target.backendUrl,
						...(options.emitProgress
							? { emitProgress: options.emitProgress }
							: undefined),
					});
					notes.push(...funnel.notes);
					gateway = funnel.gatewayHostname;
				}

				if (!gateway) {
					skipped += 1;
					results.push({
						resource: target.resource,
						hostname,
						gatewayHostname: null,
						applied: false,
						note: "no authenticated gateway (publish Funnel or set gatewayHostname)",
					});
					continue;
				}

				try {
					const result = await options.dns.reconcileEntrypoint({
						tenantId,
						hostname,
						gatewayHostname: gateway,
					});
					gateways.set(target.resource, gateway);
					if (result.applied) registered += 1;
					else skipped += 1;
					results.push({
						resource: target.resource,
						hostname,
						gatewayHostname: gateway,
						applied: result.applied,
						note: result.applied
							? "dns upserted"
							: "dns suggested only (managedBy != hobo)",
					});

					await options.metering?.emit(
						createUsageEvent({
							tenantId,
							eventType: "dns.dynamic_register",
							resource: hostname,
							metadata: {
								applied: result.applied,
								gateway,
								app: target.app,
							},
						}),
					);
				} catch (error) {
					skipped += 1;
					const message =
						error instanceof Error ? error.message : String(error);
					notes.push(message);
					results.push({
						resource: target.resource,
						hostname,
						gatewayHostname: gateway,
						applied: false,
						note: message,
					});
				}
			}

			lastResults = results;
			options.emitProgress?.(
				`hobo dynamic-dns: registered=${registered} skipped=${skipped}`,
			);
			return { registered, skipped, notes };
		},
	};
}
