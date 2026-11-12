/**
 * Cross-cloud overlay network port.
 * Primary implementation: Tailscale. Strong alternative: Netbird.
 */

import type { TenantId } from "./tenant.js";

export type OverlayProviderKind = "tailscale" | "netbird";

export interface OverlayIdentity {
	readonly nodeId: string;
	readonly hostname: string;
	readonly overlayIps: readonly string[];
	readonly tags: readonly string[];
	readonly tenantId: TenantId;
	/**
	 * The fleet member this overlay node belongs to (`dev_…`), when the node is
	 * a HoBo Fleet device (ADR-0182). Absent for nodes joined outside a fleet.
	 */
	readonly memberId?: string;
}

export interface OverlayJoinOptions {
	readonly tenantId: TenantId;
	readonly hostname: string;
	readonly tags: readonly string[];
	/**
	 * Auth key / enrollment token — never logged, stored, or passed on a command
	 * line. Only ever the `credential` of an `OverlayJoin` that the HoBo Fleet
	 * authority minted for this member at enrollment (ADR-0182): short-lived,
	 * single-use and tagged to the member. It is never read from the
	 * environment or a configuration file.
	 */
	readonly authKey?: string;
	readonly emitProgress?: (message: string) => void;
}

export interface OverlayJoinResult {
	readonly identity: OverlayIdentity;
	readonly provider: OverlayProviderKind;
	readonly ready: boolean;
	readonly notes: readonly string[];
}

export interface MagicDnsSplitConfig {
	/** Domain suffixes to resolve via overlay DNS (e.g. hobo.test). */
	readonly domains: readonly string[];
	/** Nameserver IPs or MagicDNS names that own those domains. */
	readonly nameservers: readonly string[];
	readonly tenantId: TenantId;
}

export interface MagicDnsSplitResult {
	readonly applied: boolean;
	readonly notes: readonly string[];
	readonly domains: readonly string[];
}

export interface FunnelPublishOptions {
	readonly tenantId: TenantId;
	/** Local backend to expose through Funnel (e.g. http://127.0.0.1:7071). */
	readonly backendUrl: string;
	/** Optional path/port for funnel CLI. */
	readonly localPort?: number;
	/** Desired public hostname hint (provider may assign *.ts.net). */
	readonly hostnameHint?: string;
	readonly emitProgress?: (message: string) => void;
}

export interface FunnelPublishResult {
	readonly enabled: boolean;
	/** True only when the provider confirmed that a public route was configured. */
	readonly confirmed?: boolean;
	/** Authenticated gateway hostname (never a raw overlay IP). */
	readonly gatewayHostname: string | null;
	readonly notes: readonly string[];
}

export interface OverlayNetwork {
	readonly provider: OverlayProviderKind;
	join(options: OverlayJoinOptions): Promise<OverlayJoinResult>;
	status(): Promise<OverlayIdentity | null>;
	leave(): Promise<void>;
	/** Preferred tags for a role under a tenant. */
	tenantTags(input: {
		readonly tenantId: TenantId;
		readonly role: "broker" | "junction" | "laptop" | "gateway";
		readonly env?: string;
		readonly cloud?: string;
		/** Hard isolation: stamp overlayNetworkId into tags. */
		readonly overlayNetworkId?: string;
	}): readonly string[];
	/** Optional: configure MagicDNS / split DNS for hierarchical names. */
	configureMagicDns?(config: MagicDnsSplitConfig): Promise<MagicDnsSplitResult>;
	/** Optional: publish an authenticated public gateway (Funnel / reverse proxy). */
	publishFunnel?(options: FunnelPublishOptions): Promise<FunnelPublishResult>;
}
