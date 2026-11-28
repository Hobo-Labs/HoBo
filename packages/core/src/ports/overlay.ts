import type { TenantId } from "./tenant.js";

export type OverlayProviderKind = "tailscale" | "netbird";

export interface OverlayIdentity {
	readonly nodeId: string;
	readonly hostname: string;
	readonly overlayIps: readonly string[];
	readonly tags: readonly string[];
	readonly tenantId: TenantId;
	readonly memberId?: string;
}

export interface OverlayJoinOptions {
	readonly tenantId: TenantId;
	readonly hostname: string;
	readonly tags: readonly string[];
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
	readonly domains: readonly string[];
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
	readonly backendUrl: string;
	readonly localPort?: number;
	readonly hostnameHint?: string;
	readonly emitProgress?: (message: string) => void;
}

export interface FunnelPublishResult {
	readonly enabled: boolean;
	readonly confirmed?: boolean;
	readonly gatewayHostname: string | null;
	readonly notes: readonly string[];
}

export interface OverlayNetwork {
	readonly provider: OverlayProviderKind;
	join(options: OverlayJoinOptions): Promise<OverlayJoinResult>;
	status(): Promise<OverlayIdentity | null>;
	leave(): Promise<void>;
	tenantTags(input: {
		readonly tenantId: TenantId;
		readonly role: "broker" | "junction" | "laptop" | "gateway";
		readonly env?: string;
		readonly cloud?: string;
		readonly overlayNetworkId?: string;
	}): readonly string[];
	configureMagicDns?(config: MagicDnsSplitConfig): Promise<MagicDnsSplitResult>;
	publishFunnel?(options: FunnelPublishOptions): Promise<FunnelPublishResult>;
}
