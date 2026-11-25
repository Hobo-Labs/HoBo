/**
 * Pluggable public/custom DNS management.
 *
 * managedBy:
 *  - "hobo"           → HoBo reconciles entrypoint records via a DnsProvider
 *  - "cloud-provider" → platform owns the zone; HoBo may only suggest records
 *  - "none"           → no public DNS ownership
 *
 * Public records must target authenticated gateways only (never raw overlay IPs).
 */

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
	/** When true, content is an authenticated gateway hostname / anycast entry. */
	readonly gatewayTarget: boolean;
}

export interface PublicDnsConfig {
	readonly managedBy: DnsManagedBy;
	readonly provider: DnsProviderKind;
	readonly zone?: string;
	readonly credentials?: Readonly<Record<string, string>>;
	/**
	 * Allowed gateway host patterns for public records when managedBy=hobo.
	 * Example: `*.ts.net`, `*.cloudflareaccess.com`, `*.cfargotunnel.com`.
	 */
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
	/** Reconcile entrypoint records when managedBy=hobo; no-op ownership otherwise. */
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
