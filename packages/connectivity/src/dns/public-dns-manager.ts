import {
	createUsageEvent,
	type DnsProvider,
	type DnsRecord,
	type MeteringBus,
	type PublicDnsConfig,
	type PublicDnsManager,
	type TenantId,
} from "@hobo/core";

const DEFAULT_GATEWAY_SUFFIXES = [
	".ts.net",
	".tailscale.com",
	".cloudflareaccess.com",
	".cfargotunnel.com",
	".netbird.selfhosted",
	".nb.local",
] as const;

function isGatewayHostname(
	hostname: string,
	allowed: readonly string[],
): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	// Reject raw IPv4 / IPv6
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
	if (host.includes(":")) return false;
	return allowed.some(
		(suffix) => host.endsWith(suffix.toLowerCase()) || host === suffix.slice(1),
	);
}

/**
 * Configuration-driven public DNS manager.
 * When managedBy is cloud-provider|none, HoBo never writes the zone.
 */
export function createPublicDnsManager(options: {
	readonly config: PublicDnsConfig;
	readonly provider?: DnsProvider;
	readonly metering?: MeteringBus;
}): PublicDnsManager {
	const config = options.config;
	const allowed = config.allowedGatewaySuffixes ?? DEFAULT_GATEWAY_SUFFIXES;
	const metering = options.metering;

	async function buildRecord(input: {
		readonly hostname: string;
		readonly gatewayHostname: string;
	}): Promise<DnsRecord> {
		if (!isGatewayHostname(input.gatewayHostname, allowed)) {
			throw new Error(
				`public DNS must target an authenticated gateway, not raw overlay IP or untrusted host: ${input.gatewayHostname}`,
			);
		}
		return {
			name: input.hostname,
			type: "CNAME",
			content: input.gatewayHostname.replace(/\.$/, ""),
			ttl: 300,
			gatewayTarget: true,
		};
	}

	return {
		config,
		async suggestEntrypoint(input) {
			const record = await buildRecord(input);
			if (metering) {
				await metering.emit(
					createUsageEvent({
						tenantId: input.tenantId,
						eventType: "dns.suggest",
						resource: input.hostname,
						metadata: {
							managedBy: config.managedBy,
							provider: config.provider,
							gateway: input.gatewayHostname,
						},
					}),
				);
			}
			return record;
		},
		async reconcileEntrypoint(input) {
			const suggested = await buildRecord(input);
			if (config.managedBy !== "hobo") {
				if (metering) {
					await metering.emit(
						createUsageEvent({
							tenantId: input.tenantId,
							eventType: "dns.suggest",
							resource: input.hostname,
							metadata: {
								managedBy: config.managedBy,
								provider: config.provider,
								applied: false,
							},
						}),
					);
				}
				return { applied: false, suggested };
			}
			const zone = config.zone;
			const provider = options.provider;
			if (!zone || !provider) {
				throw new Error(
					"managedBy=hobo requires dns.public.zone and a concrete DnsProvider",
				);
			}
			// SAFETY: assertion required at this I/O or test boundary.
			await provider.upsert(input.tenantId as TenantId, zone, suggested);
			if (metering) {
				await metering.emit(
					createUsageEvent({
						tenantId: input.tenantId,
						eventType: "dns.record_upsert",
						resource: input.hostname,
						metadata: {
							managedBy: "hobo",
							provider: config.provider,
							zone,
							gateway: input.gatewayHostname,
						},
					}),
				);
			}
			return { applied: true, suggested };
		},
	};
}
