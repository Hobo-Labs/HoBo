import type {
	DnsProvider,
	DnsRecord,
	DnsRecordType,
	TenantId,
} from "@hobo/core";

function key(
	tenantId: TenantId,
	zone: string,
	name: string,
	type: string,
): string {
	return `${tenantId}::${zone}::${name}::${type}`;
}

/** In-process DnsProvider for tests and local reconcile dry-runs. */
export function createMemoryDnsProvider(): DnsProvider & {
	readonly store: ReadonlyMap<string, DnsRecord>;
} {
	const store = new Map<string, DnsRecord>();
	return {
		kind: "memory",
		get store() {
			return store;
		},
		async upsert(tenantId, zone, record) {
			store.set(key(tenantId, zone, record.name, record.type), record);
		},
		async remove(tenantId, zone, name, type: DnsRecordType) {
			store.delete(key(tenantId, zone, name, type));
		},
		async list(tenantId, zone) {
			const prefix = `${tenantId}::${zone}::`;
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([, v]) => v);
		},
	};
}
