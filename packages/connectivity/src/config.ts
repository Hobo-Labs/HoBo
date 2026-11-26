import type {
	DnsManagedBy,
	DnsProviderKind,
	OverlayProviderKind,
	PublicDnsConfig,
} from "@hobo/core";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export interface ConnectivityConfig {
	readonly overlay: {
		readonly provider: OverlayProviderKind;
		readonly magicDnsDomains: readonly string[];
		readonly enableFunnel: boolean;
	};
	readonly dns: {
		readonly public: PublicDnsConfig;
	};
	readonly naming: {
		readonly multiTenant: boolean;
		readonly defaultEnv: string;
		readonly localTld: string;
		readonly overlayTld: string;
	};
	readonly metering: {
		readonly enabled: boolean;
		readonly sinks: readonly ("memory" | "log" | "billing")[];
	};
	readonly tenancy: {
		readonly defaultIsolationMode:
			| "soft"
			| "hard-overlay"
			| "hard-control-plane";
	};
	readonly policy: {
		readonly engine: "tag-acl" | "opa";
		readonly opaUrl?: string;
	};
}

export const DEFAULT_CONNECTIVITY_CONFIG: ConnectivityConfig = {
	overlay: {
		provider: "tailscale",
		magicDnsDomains: ["hobo.test", "hobo.internal"],
		enableFunnel: true,
	},
	dns: {
		public: {
			managedBy: "none",
			provider: "none",
		},
	},
	naming: {
		multiTenant: false,
		defaultEnv: "prod",
		localTld: "localhost",
		overlayTld: "test",
	},
	metering: {
		enabled: true,
		sinks: ["memory", "billing"],
	},
	tenancy: {
		defaultIsolationMode: "soft",
	},
	policy: {
		engine: "tag-acl",
	},
};

export function parseConnectivityConfig(raw: JsonValue): ConnectivityConfig {
	if (raw === null || raw === undefined || !isJsonObject(raw)) {
		return DEFAULT_CONNECTIVITY_CONFIG;
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const obj = raw as JsonObject;
	// SAFETY: assertion required at this I/O or test boundary.
	const overlay = (obj.overlay ?? {}) as JsonObject;
	// SAFETY: assertion required at this I/O or test boundary.
	const dns = (obj.dns ?? {}) as JsonObject;
	// SAFETY: assertion required at this I/O or test boundary.
	const dnsPublic = (dns.public ?? {}) as JsonObject;
	// SAFETY: assertion required at this I/O or test boundary.
	const naming = (obj.naming ?? {}) as JsonObject;
	// SAFETY: assertion required at this I/O or test boundary.
	const metering = (obj.metering ?? {}) as JsonObject;
	// SAFETY: assertion required at this I/O or test boundary.
	const tenancy = (obj.tenancy ?? {}) as JsonObject;
	// SAFETY: assertion required at this I/O or test boundary.
	const policy = (obj.policy ?? {}) as JsonObject;

	const managedBy = parseManagedBy(dnsPublic.managedBy);
	const provider = parseProvider(dnsPublic.provider);
	const overlayProvider = parseOverlay(overlay.provider);

	return {
		overlay: {
			provider: overlayProvider,
			magicDnsDomains: Array.isArray(overlay.magicDnsDomains)
				? // SAFETY: assertion required at this I/O or test boundary.
					overlay.magicDnsDomains.filter((s): s is string => isJsonString(s))
				: DEFAULT_CONNECTIVITY_CONFIG.overlay.magicDnsDomains,
			enableFunnel: overlay.enableFunnel !== false,
		},
		dns: {
			public: {
				managedBy,
				provider,
				...(isJsonString(dnsPublic.zone)
					? { zone: dnsPublic.zone }
					: undefined),
				...(dnsPublic.credentials &&
				isJsonObject(dnsPublic.credentials) &&
				dnsPublic.credentials !== null
					? {
							credentials: Object.fromEntries(
								Object.entries(
									// SAFETY: assertion required at this I/O or test boundary.
									dnsPublic.credentials as JsonObject,
								).filter((entry): entry is [string, string] =>
									isJsonString(entry[1]),
								),
							),
						}
					: undefined),
				...(Array.isArray(dnsPublic.allowedGatewaySuffixes)
					? {
							allowedGatewaySuffixes: dnsPublic.allowedGatewaySuffixes.filter(
								(s): s is string => isJsonString(s),
							),
						}
					: undefined),
			},
		},
		naming: {
			multiTenant: naming.multiTenant === true,
			defaultEnv: isJsonString(naming.defaultEnv) ? naming.defaultEnv : "prod",
			localTld: isJsonString(naming.localTld) ? naming.localTld : "localhost",
			overlayTld: isJsonString(naming.overlayTld) ? naming.overlayTld : "test",
		},
		metering: {
			enabled: metering.enabled !== false,
			sinks: Array.isArray(metering.sinks)
				? // SAFETY: assertion required at this I/O or test boundary.
					metering.sinks.filter(
						(s): s is "memory" | "log" | "billing" =>
							s === "memory" || s === "log" || s === "billing",
					)
				: ["memory", "billing"],
		},
		tenancy: {
			defaultIsolationMode:
				tenancy.defaultIsolationMode === "hard-overlay" ||
				tenancy.defaultIsolationMode === "hard-control-plane"
					? tenancy.defaultIsolationMode
					: "soft",
		},
		policy: {
			engine: policy.engine === "opa" ? "opa" : "tag-acl",
			...(isJsonString(policy.opaUrl) ? { opaUrl: policy.opaUrl } : undefined),
		},
	};
}

function parseManagedBy(raw: JsonValue | undefined): DnsManagedBy {
	if (raw === "hobo" || raw === "cloud-provider" || raw === "none") return raw;
	return "none";
}

function parseProvider(raw: JsonValue | undefined): DnsProviderKind {
	const allowed: DnsProviderKind[] = [
		"cloudflare",
		"route53",
		"azure",
		"google",
		"dnscontrol",
		"octodns",
		"memory",
		"none",
	];
	// SAFETY: assertion required at this I/O or test boundary.
	if (isJsonString(raw) && (allowed as string[]).includes(raw)) {
		// SAFETY: assertion required at this I/O or test boundary.
		return raw as DnsProviderKind;
	}
	return "none";
}

function parseOverlay(raw: JsonValue | undefined): OverlayProviderKind {
	if (raw === "netbird") return "netbird";
	return "tailscale";
}
