import type { TenantId } from "./tenant.js";

export type DnsManagedBy = "hobo" | "cloud-provider" | "none";

export type DnsProviderKind =
	| "cloudflare"
	| "route53"
	| "azure"
	| "google"
	| "dnscontrol"
	| "octodns"
	| "memory"
	| "none";

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT";

export interface DnsRecord {
	readonly name: string;
	readonly type: DnsRecordType;
	readonly content: string;
	readonly ttl?: number;
	readonly gatewayTarget: boolean;
}

export interface PublicDnsConfig {
	readonly managedBy: DnsManagedBy;
	readonly provider: DnsProviderKind;
	readonly zone?: string;
	readonly credentials?: Readonly<Record<string, string>>;
	readonly allowedGatewaySuffixes?: readonly string[];
}

export interface DnsProvider {
	readonly kind: DnsProviderKind;
	upsert(tenantId: TenantId, zone: string, record: DnsRecord): Promise<void>;
	remove(
		tenantId: TenantId,
		zone: string,
		name: string,
		type: DnsRecordType,
	): Promise<void>;
	list(tenantId: TenantId, zone: string): Promise<readonly DnsRecord[]>;
}

export interface PublicDnsManager {
	readonly config: PublicDnsConfig;
	reconcileEntrypoint(input: {
		readonly tenantId: TenantId;
		readonly hostname: string;
		readonly gatewayHostname: string;
	}): Promise<{ readonly applied: boolean; readonly suggested?: DnsRecord }>;
	suggestEntrypoint(input: {
		readonly tenantId: TenantId;
		readonly hostname: string;
		readonly gatewayHostname: string;
	}): Promise<DnsRecord>;
}
